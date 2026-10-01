package app.projectionmapper.server;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;

/**
 * Tiny dependency-free HTTP + WebSocket server. It is a line-by-line port of
 * server/server.js so the same web app works with either:
 *
 *   GET  /                 phone controller (index.html)
 *   GET  /display.html     projector output
 *   GET  /api/info         {"ips":[...],"port":N}
 *   GET/PUT /api/state     saved project JSON
 *   GET/POST /api/media    list / upload images + videos (raw body, ?name=)
 *   DELETE /api/media/NAME delete a file
 *   GET  /media/NAME       serve uploads (with Range support for video)
 *   GET  /ws?role=...      WebSocket relay between projector and phones
 *
 * The same routes are also served over https (default port 8443) with a fixed
 * self-signed certificate: phone browsers only allow the microphone (sound-
 * reactive mode) on secure pages.
 */
public final class MapperServer {

    /** Where the static web app comes from (a folder, or Android assets). */
    public interface WebRoot {
        /** @return file contents, or null if it does not exist. */
        byte[] read(String path) throws IOException;
    }

    public static final String VERSION = "1.1.0";
    private static final long MAX_STATE = 5L * 1024 * 1024;
    private static final long MAX_MEDIA = 1024L * 1024 * 1024;
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final Set<String> MEDIA_EXT = new java.util.HashSet<>(Arrays.asList(
            ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm", ".mov", ".m4v"));
    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put(".html", "text/html; charset=utf-8");
        TYPES.put(".js", "text/javascript; charset=utf-8");
        TYPES.put(".mjs", "text/javascript; charset=utf-8");
        TYPES.put(".css", "text/css; charset=utf-8");
        TYPES.put(".json", "application/json; charset=utf-8");
        TYPES.put(".webmanifest", "application/manifest+json");
        TYPES.put(".svg", "image/svg+xml");
        TYPES.put(".png", "image/png");
        TYPES.put(".jpg", "image/jpeg");
        TYPES.put(".jpeg", "image/jpeg");
        TYPES.put(".gif", "image/gif");
        TYPES.put(".webp", "image/webp");
        TYPES.put(".ico", "image/x-icon");
        TYPES.put(".mp4", "video/mp4");
        TYPES.put(".m4v", "video/mp4");
        TYPES.put(".webm", "video/webm");
        TYPES.put(".mov", "video/quicktime");
        TYPES.put(".txt", "text/plain; charset=utf-8");
    }

    private final WebRoot web;
    private final File dataDir;
    private final File mediaDir;
    private final File stateFile;
    private final int requestedPort;
    private final int requestedHttpsPort;
    private volatile ServerSocket tlsSocket;
    private int httpsPort;
    private final ExecutorService pool;
    private final Set<WsClient> clients = Collections.newSetFromMap(new ConcurrentHashMap<WsClient, Boolean>());
    private final SecureRandom random = new SecureRandom();
    private volatile ServerSocket serverSocket;
    private volatile boolean running;
    private int port;

    public MapperServer(WebRoot web, File dataDir, int port) {
        this(web, dataDir, port, port == 8080 ? 8443 : (port == 0 ? 0 : port + 1));
    }

    public MapperServer(WebRoot web, File dataDir, int port, int httpsPort) {
        this.requestedHttpsPort = httpsPort;
        this.web = web;
        this.dataDir = dataDir;
        this.mediaDir = new File(dataDir, "media");
        this.stateFile = new File(dataDir, "state.json");
        this.requestedPort = port;
        this.pool = Executors.newCachedThreadPool(new ThreadFactory() {
            private int n;

            @Override
            public synchronized Thread newThread(Runnable r) {
                Thread t = new Thread(r, "mapper-" + (n++));
                t.setDaemon(true);
                return t;
            }
        });
    }

    /**
     * Binds to the requested port (or the next free one of the following 10)
     * and starts accepting connections in the background.
     */
    public synchronized int start() throws IOException {
        if (running) return port;
        //noinspection ResultOfMethodCallIgnored
        mediaDir.mkdirs();
        IOException last = null;
        for (int p = requestedPort; p < requestedPort + 10; p++) {
            try {
                ServerSocket ss = new ServerSocket();
                ss.setReuseAddress(true);
                ss.bind(new InetSocketAddress(p));
                serverSocket = ss;
                port = ss.getLocalPort();
                break;
            } catch (IOException e) {
                last = e;
                if (requestedPort == 0) break;
            }
        }
        if (serverSocket == null) throw last != null ? last : new IOException("could not bind");
        running = true;
        // Bind https before answering anything, so /api/info is right from the first request.
        try {
            startTls();
        } catch (Exception e) {
            httpsPort = 0; // sound mode unavailable, everything else works
            System.err.println("https disabled: " + e);
        }
        startAcceptor(serverSocket, "mapper-accept");
        return port;
    }

    public int getHttpsPort() {
        return httpsPort;
    }

    private void startAcceptor(final ServerSocket ss, String name) {
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop(ss);
            }
        }, name);
        t.setDaemon(true);
        t.start();
    }

    private void startTls() throws Exception {
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(keyManagers(), null, null);
        IOException last = null;
        int first = requestedHttpsPort;
        for (int p = first; p < first + 10; p++) {
            try {
                ServerSocket ss = ctx.getServerSocketFactory().createServerSocket();
                ss.setReuseAddress(true);
                ss.bind(new InetSocketAddress(p));
                tlsSocket = ss;
                httpsPort = ss.getLocalPort();
                startAcceptor(ss, "mapper-accept-tls");
                return;
            } catch (IOException e) {
                last = e;
                if (first == 0) break;
            }
        }
        throw last != null ? last : new IOException("could not bind https");
    }

    /** Key managers for the bundled self-signed certificate (tls/*.pem). */
    private static javax.net.ssl.KeyManager[] keyManagers() throws Exception {
        byte[] keyDer = pemBody(resource("tls/key.pem"));
        PrivateKey key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(keyDer));
        Certificate cert = CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(resource("tls/cert.pem").getBytes(StandardCharsets.US_ASCII)));
        KeyStore ks = KeyStore.getInstance(KeyStore.getDefaultType());
        ks.load(null, null);
        char[] pw = "projectionmapper".toCharArray();
        ks.setKeyEntry("mapper", key, pw, new Certificate[]{cert});
        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(ks, pw);
        return kmf.getKeyManagers();
    }

    private static String resource(String name) throws IOException {
        InputStream in = MapperServer.class.getResourceAsStream(name);
        if (in == null) throw new IOException("missing resource " + name);
        try {
            return new String(readAll(in), StandardCharsets.US_ASCII);
        } finally {
            in.close();
        }
    }

    static byte[] pemBody(String pem) {
        StringBuilder b64 = new StringBuilder();
        for (String line : pem.split("\\r?\\n")) {
            if (line.startsWith("-----") || line.trim().isEmpty()) continue;
            b64.append(line.trim());
        }
        return base64Decode(b64.toString());
    }

    public int getPort() {
        return port;
    }

    public synchronized void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        try {
            if (tlsSocket != null) tlsSocket.close();
        } catch (IOException ignored) {
        }
        for (WsClient c : clients) c.close();
        clients.clear();
        pool.shutdownNow();
    }

    private void acceptLoop(ServerSocket listener) {
        while (running) {
            try {
                final Socket s = listener.accept();
                pool.execute(() -> handleConnection(s));
            } catch (IOException e) {
                if (!running) return;
            }
        }
    }

    // ------------------------------------------------------------------ HTTP

    private static final class Request {
        String method;
        String path;
        Map<String, String> query = new HashMap<>();
        Map<String, String> headers = new HashMap<>();
        InputStream body;
    }

    private void handleConnection(Socket socket) {
        try {
            socket.setSoTimeout(30000);
            socket.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(socket.getInputStream(), 16384);
            OutputStream out = socket.getOutputStream();
            Request req = readRequest(in);
            if (req == null) {
                socket.close();
                return;
            }
            if ("/ws".equals(req.path) && "websocket".equalsIgnoreCase(req.headers.get("upgrade"))) {
                handleWebSocket(socket, in, out, req);
                return;
            }
            try {
                route(req, out);
            } catch (Exception e) {
                try {
                    sendJson(out, 500, "{\"error\":" + jsonStr(String.valueOf(e.getMessage())) + "}");
                } catch (IOException ignored) {
                }
            }
            out.flush();
            socket.close();
        } catch (IOException e) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private Request readRequest(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int state = 0;
        while (state < 4) {
            int b = in.read();
            if (b < 0) return null;
            head.write(b);
            if (head.size() > 32768) return null;
            if ((state == 0 || state == 2) && b == '\r') state++;
            else if ((state == 1 || state == 3) && b == '\n') state++;
            else state = b == '\r' ? 1 : 0;
        }
        String[] lines = head.toString("ISO-8859-1").split("\r\n");
        String[] first = lines[0].split(" ");
        if (first.length < 2) return null;
        Request r = new Request();
        r.method = first[0].toUpperCase(Locale.ROOT);
        String target = first[1];
        int q = target.indexOf('?');
        String rawPath = q >= 0 ? target.substring(0, q) : target;
        r.path = URLDecoder.decode(rawPath.replace("+", "%2B"), "UTF-8");
        if (q >= 0) {
            for (String kv : target.substring(q + 1).split("&")) {
                if (kv.isEmpty()) continue;
                int e = kv.indexOf('=');
                String k = URLDecoder.decode(e >= 0 ? kv.substring(0, e) : kv, "UTF-8");
                String v = e >= 0 ? URLDecoder.decode(kv.substring(e + 1), "UTF-8") : "";
                r.query.put(k, v);
            }
        }
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c > 0) {
                r.headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
            }
        }
        r.body = in;
        return r;
    }

    private void route(Request req, OutputStream out) throws IOException {
        String p = req.path;
        String m = req.method;

        if (p.equals("/api/info")) {
            StringBuilder ips = new StringBuilder("[");
            List<String> list = lanAddresses();
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) ips.append(',');
                ips.append(jsonStr(list.get(i)));
            }
            ips.append(']');
            sendJson(out, 200, "{\"app\":\"projection-mapper\",\"version\":\"" + VERSION + "\",\"port\":" + port
                    + ",\"httpsPort\":" + httpsPort + ",\"ips\":" + ips + ",\"server\":\"java\"}");
            return;
        }
        if (p.equals("/api/state")) {
            if (m.equals("GET")) {
                byte[] data = stateFile.isFile() ? readFile(stateFile) : "null".getBytes(StandardCharsets.UTF_8);
                send(out, 200, "application/json; charset=utf-8", data, null);
                return;
            }
            if (m.equals("PUT") || m.equals("POST")) {
                long len = contentLength(req);
                if (len < 0) {
                    sendJson(out, 411, "{\"error\":\"length required\"}");
                    return;
                }
                if (len > MAX_STATE) {
                    sendJson(out, 413, "{\"error\":\"too large\"}");
                    return;
                }
                byte[] body = readN(req.body, (int) len);
                String text = new String(body, StandardCharsets.UTF_8).trim();
                if (!(text.startsWith("{") || text.startsWith("[") || text.equals("null"))) {
                    sendJson(out, 400, "{\"error\":\"invalid json\"}");
                    return;
                }
                File tmp = new File(dataDir, "state.json.tmp");
                try (FileOutputStream fo = new FileOutputStream(tmp)) {
                    fo.write(body);
                    fo.getFD().sync();
                }
                if (!tmp.renameTo(stateFile)) {
                    //noinspection ResultOfMethodCallIgnored
                    stateFile.delete();
                    //noinspection ResultOfMethodCallIgnored
                    tmp.renameTo(stateFile);
                }
                sendJson(out, 200, "{\"ok\":true}");
                return;
            }
        }
        if (p.equals("/api/media") && m.equals("GET")) {
            sendJson(out, 200, mediaListJson());
            return;
        }
        if (p.equals("/api/media") && m.equals("POST")) {
            String name = safeName(req.query.get("name"));
            String ext = ext(name);
            if (!MEDIA_EXT.contains(ext)) {
                sendJson(out, 400, "{\"error\":\"unsupported file type\"}");
                return;
            }
            long len = contentLength(req);
            if (len < 0) {
                sendJson(out, 411, "{\"error\":\"length required\"}");
                return;
            }
            if (len > MAX_MEDIA) {
                sendJson(out, 413, "{\"error\":\"too large\"}");
                return;
            }
            String file = randomHex(4) + "-" + name;
            File dest = new File(mediaDir, file);
            try (FileOutputStream fo = new FileOutputStream(dest)) {
                byte[] buf = new byte[65536];
                long left = len;
                while (left > 0) {
                    int n = req.body.read(buf, 0, (int) Math.min(buf.length, left));
                    if (n < 0) throw new IOException("upload interrupted");
                    fo.write(buf, 0, n);
                    left -= n;
                }
            } catch (IOException e) {
                //noinspection ResultOfMethodCallIgnored
                dest.delete();
                throw e;
            }
            sendJson(out, 200, "{\"url\":" + jsonStr("/media/" + file) + ",\"name\":" + jsonStr(name) + ",\"size\":" + len + "}");
            return;
        }
        if (p.startsWith("/api/media/") && m.equals("DELETE")) {
            File f = new File(mediaDir, safeName(p.substring("/api/media/".length())));
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            sendJson(out, 200, "{\"ok\":true}");
            return;
        }
        if (p.startsWith("/media/")) {
            serveMedia(req, out, new File(mediaDir, safeName(p.substring(7))));
            return;
        }

        // Static web app
        if (p.equals("/")) p = "/index.html";
        if (p.equals("/display") || p.equals("/tv")) p = "/display.html";
        if (p.contains("..") || p.contains("\\")) {
            sendJson(out, 403, "{\"error\":\"forbidden\"}");
            return;
        }
        byte[] data = web.read(p.substring(1));
        if (data == null) {
            sendJson(out, 404, "{\"error\":\"not found\"}");
            return;
        }
        if (m.equals("HEAD")) {
            writeHead(out, 200, typeOf(p), data.length, null);
        } else {
            send(out, 200, typeOf(p), data, "no-cache");
        }
    }

    private void serveMedia(Request req, OutputStream out, File file) throws IOException {
        if (!file.isFile()) {
            sendJson(out, 404, "{\"error\":\"not found\"}");
            return;
        }
        long size = file.length();
        String type = typeOf(file.getName());
        String range = req.headers.get("range");
        long start = 0, end = size - 1;
        int status = 200;
        Map<String, String> extra = new HashMap<>();
        extra.put("Accept-Ranges", "bytes");
        extra.put("Cache-Control", "public, max-age=31536000, immutable");
        if (range != null) {
            Matcher mt = Pattern.compile("bytes=(\\d*)-(\\d*)").matcher(range);
            if (mt.find()) {
                String a = mt.group(1), b = mt.group(2);
                if (a.isEmpty() && !b.isEmpty()) {
                    start = Math.max(0, size - Long.parseLong(b));
                } else if (!a.isEmpty()) {
                    start = Long.parseLong(a);
                    if (!b.isEmpty()) end = Math.min(Long.parseLong(b), size - 1);
                }
                if (start > end || start >= size) {
                    Map<String, String> h = new HashMap<>();
                    h.put("Content-Range", "bytes */" + size);
                    writeHead(out, 416, "text/plain", 0, h);
                    return;
                }
                status = 206;
                extra.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
            }
        }
        long len = end - start + 1;
        writeHead(out, status, type, len, extra);
        if (req.method.equals("HEAD")) return;
        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            raf.seek(start);
            byte[] buf = new byte[65536];
            long left = len;
            while (left > 0) {
                int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                out.write(buf, 0, n);
                left -= n;
            }
        }
    }

    private String mediaListJson() {
        File[] files = mediaDir.listFiles();
        List<File> list = new ArrayList<>();
        if (files != null) {
            for (File f : files) if (f.isFile() && MEDIA_EXT.contains(ext(f.getName()))) list.add(f);
        }
        Collections.sort(list, new Comparator<File>() {
            @Override
            public int compare(File a, File b) {
                return Long.compare(b.lastModified(), a.lastModified());
            }
        });
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            File f = list.get(i);
            String e = ext(f.getName());
            boolean video = e.equals(".mp4") || e.equals(".webm") || e.equals(".mov") || e.equals(".m4v");
            if (i > 0) sb.append(',');
            sb.append("{\"url\":").append(jsonStr("/media/" + f.getName()))
                    .append(",\"name\":").append(jsonStr(f.getName().replaceFirst("^[a-z0-9]+-", "")))
                    .append(",\"size\":").append(f.length())
                    .append(",\"kind\":\"").append(video ? "video" : "image").append('"')
                    .append(",\"mtime\":").append(f.lastModified()).append('}');
        }
        return sb.append(']').toString();
    }

    // ------------------------------------------------------------- WebSocket

    private final class WsClient {
        final Socket socket;
        final OutputStream out;
        final boolean display;
        final ExecutorService sender = Executors.newSingleThreadExecutor(new ThreadFactory() {
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "mapper-ws-send");
                t.setDaemon(true);
                return t;
            }
        });
        volatile boolean open = true;

        WsClient(Socket socket, OutputStream out, boolean display) {
            this.socket = socket;
            this.out = out;
            this.display = display;
        }

        void sendText(final String text) {
            if (!open) return;
            final byte[] frame = textFrame(text);
            try {
                sender.execute(() -> {
                    try {
                        synchronized (out) {
                            out.write(frame);
                            out.flush();
                        }
                    } catch (IOException e) {
                        close();
                    }
                });
            } catch (java.util.concurrent.RejectedExecutionException ignored) {
            }
        }

        void sendControl(int opcode, byte[] payload) {
            try {
                synchronized (out) {
                    out.write(0x80 | opcode);
                    out.write(payload.length);
                    out.write(payload);
                    out.flush();
                }
            } catch (IOException e) {
                close();
            }
        }

        void close() {
            if (!open) return;
            open = false;
            sender.shutdownNow();
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void handleWebSocket(Socket socket, InputStream in, OutputStream out, Request req) throws IOException {
        String key = req.headers.get("sec-websocket-key");
        if (key == null) {
            socket.close();
            return;
        }
        String accept;
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            accept = base64(sha1.digest((key + WS_GUID).getBytes(StandardCharsets.ISO_8859_1)));
        } catch (Exception e) {
            throw new IOException(e);
        }
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
        socket.setSoTimeout(90000); // clients ping every 15s
        WsClient client = new WsClient(socket, out, "display".equals(req.query.get("role")));
        clients.add(client);
        broadcastPeers();
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        int messageOp = 1;
        try {
            while (client.open) {
                int b0 = in.read();
                int b1 = in.read();
                if (b0 < 0 || b1 < 0) break;
                boolean fin = (b0 & 0x80) != 0;
                int op = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7f;
                if (len == 126) {
                    len = ((long) readByte(in) << 8) | readByte(in);
                } else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
                }
                if (len > 32L * 1024 * 1024) break;
                byte[] mask = masked ? readN(in, 4) : null;
                byte[] payload = readN(in, (int) len);
                if (mask != null) {
                    for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                }
                if (op == 0x8) { // close
                    client.sendControl(0x8, new byte[0]);
                    break;
                } else if (op == 0x9) { // ping
                    client.sendControl(0xA, payload.length > 125 ? Arrays.copyOf(payload, 125) : payload);
                } else if (op == 0xA) { // pong
                    continue;
                } else if (op == 0x1 || op == 0x2 || op == 0x0) {
                    if (op != 0x0) {
                        message.reset();
                        messageOp = op;
                    }
                    message.write(payload);
                    if (message.size() > 32 * 1024 * 1024) break;
                    if (fin) {
                        if (messageOp == 0x1) relay(client, new String(message.toByteArray(), StandardCharsets.UTF_8));
                        message.reset();
                    }
                }
            }
        } catch (SocketException ignored) {
            // disconnected
        } catch (IOException ignored) {
            // timeout / broken pipe
        } finally {
            client.close();
            if (clients.remove(client)) broadcastPeers();
        }
    }

    private void relay(WsClient from, String text) {
        if (text.equals("{\"t\":\"ping\"}")) return;
        for (WsClient c : clients) if (c != from) c.sendText(text);
    }

    private void broadcastPeers() {
        int displays = 0, controllers = 0;
        for (WsClient c : clients) {
            if (c.display) displays++;
            else controllers++;
        }
        String msg = "{\"t\":\"peers\",\"displays\":" + displays + ",\"controllers\":" + controllers + "}";
        for (WsClient c : clients) c.sendText(msg);
    }

    /** Number of connected phones (for the TV app's status). */
    public int controllerCount() {
        int n = 0;
        for (WsClient c : clients) if (!c.display) n++;
        return n;
    }

    static byte[] textFrame(String text) {
        byte[] payload = text.getBytes(StandardCharsets.UTF_8);
        int n = payload.length;
        byte[] head;
        if (n < 126) {
            head = new byte[]{(byte) 0x81, (byte) n};
        } else if (n < 65536) {
            head = new byte[]{(byte) 0x81, 126, (byte) (n >> 8), (byte) n};
        } else {
            head = new byte[10];
            head[0] = (byte) 0x81;
            head[1] = 127;
            long l = n;
            for (int i = 0; i < 8; i++) head[9 - i] = (byte) (l >> (8 * i));
        }
        byte[] frame = new byte[head.length + n];
        System.arraycopy(head, 0, frame, 0, head.length);
        System.arraycopy(payload, 0, frame, head.length, n);
        return frame;
    }

    // --------------------------------------------------------------- helpers

    private static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    static byte[] base64Decode(String s) {
        int[] rev = new int[128];
        java.util.Arrays.fill(rev, -1);
        for (int i = 0; i < B64.length; i++) rev[B64[i]] = i;
        ByteArrayOutputStream out = new ByteArrayOutputStream(s.length() * 3 / 4);
        int buf = 0, bits = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '=' || c >= 128 || rev[c] < 0) continue;
            buf = (buf << 6) | rev[c];
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.write((buf >> bits) & 0xff);
            }
        }
        return out.toByteArray();
    }

    /** Base64 without java.util.Base64 (unavailable before Android 8). */
    static String base64(byte[] data) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < data.length; i += 3) {
            int b = (data[i] & 0xff) << 16;
            if (i + 1 < data.length) b |= (data[i + 1] & 0xff) << 8;
            if (i + 2 < data.length) b |= data[i + 2] & 0xff;
            sb.append(B64[(b >> 18) & 63]).append(B64[(b >> 12) & 63]);
            sb.append(i + 1 < data.length ? B64[(b >> 6) & 63] : '=');
            sb.append(i + 2 < data.length ? B64[b & 63] : '=');
        }
        return sb.toString();
    }

    /** LAN IPv4 addresses, best candidate first. */
    public static List<String> lanAddresses() {
        final List<String[]> found = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) {
                        found.add(new String[]{ni.getName(), a.getHostAddress()});
                    }
                }
            }
        } catch (Exception ignored) {
        }
        Collections.sort(found, new Comparator<String[]>() {
            @Override
            public int compare(String[] a, String[] b) {
                return score(b) - score(a);
            }
        });
        List<String> out = new ArrayList<>();
        for (String[] f : found) out.add(f[1]);
        return out;
    }

    private static int score(String[] a) {
        String name = a[0].toLowerCase(Locale.ROOT), ip = a[1];
        int s = ip.startsWith("192.168.") ? 3 : ip.startsWith("10.") ? 2 : ip.startsWith("172.") ? 1 : 0;
        if (name.startsWith("wlan") || name.startsWith("eth") || name.startsWith("en") || name.startsWith("wl")) s += 2;
        if (name.contains("docker") || name.startsWith("veth") || name.startsWith("br-") || name.startsWith("tun")
                || name.startsWith("rmnet") || name.startsWith("p2p")) s -= 5;
        return s;
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) throw new IOException("eof");
        return b;
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) throw new IOException("eof");
            off += r;
        }
        return buf;
    }

    private static byte[] readFile(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            return readN(in, (int) f.length());
        }
    }

    public static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    private static long contentLength(Request r) {
        String v = r.headers.get("content-length");
        if (v == null) return -1;
        try {
            return Long.parseLong(v.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private String randomHex(int bytes) {
        byte[] b = new byte[bytes];
        random.nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static String safeName(String name) {
        if (name == null) name = "file";
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[^a-zA-Z0-9._-]+", "_");
        if (name.length() > 60) name = name.substring(name.length() - 60);
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "file";
        return name;
    }

    private static String ext(String name) {
        int d = name.lastIndexOf('.');
        return d >= 0 ? name.substring(d).toLowerCase(Locale.ROOT) : "";
    }

    private static String typeOf(String path) {
        String t = TYPES.get(ext(path));
        return t != null ? t : "application/octet-stream";
    }

    static String jsonStr(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    private static void writeHead(OutputStream out, int code, String type, long length, Map<String, String> extra) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reason(code)).append("\r\n");
        sb.append("Content-Type: ").append(type).append("\r\n");
        sb.append("Content-Length: ").append(length).append("\r\n");
        sb.append("Connection: close\r\n");
        boolean hasCache = false;
        if (extra != null) {
            for (Map.Entry<String, String> e : extra.entrySet()) {
                if (e.getKey().equalsIgnoreCase("Cache-Control")) hasCache = true;
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
        }
        if (!hasCache) sb.append("Cache-Control: no-store\r\n");
        sb.append("\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    private static void send(OutputStream out, int code, String type, byte[] body, String cache) throws IOException {
        Map<String, String> extra = null;
        if (cache != null) {
            extra = new HashMap<>();
            extra.put("Cache-Control", cache);
        }
        writeHead(out, code, type, body.length, extra);
        out.write(body);
    }

    private static void sendJson(OutputStream out, int code, String json) throws IOException {
        send(out, code, "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8), null);
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 411: return "Length Required";
            case 413: return "Payload Too Large";
            case 416: return "Range Not Satisfiable";
            default: return code >= 500 ? "Server Error" : "OK";
        }
    }
}
