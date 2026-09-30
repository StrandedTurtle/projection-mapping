package app.projectionmapper.server;

import java.io.File;
import java.io.IOException;
import java.util.List;

/**
 * Desktop entry point (handy for testing the exact server the TV app runs):
 *   java -jar mapper-server.jar --web ../web --data ./data --port 8080
 */
public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        String webDir = arg(args, "web", "web");
        String dataDir = arg(args, "data", "data");
        int port = Integer.parseInt(arg(args, "port", "8080"));
        final File root = new File(webDir).getCanonicalFile();
        MapperServer server = new MapperServer(new MapperServer.WebRoot() {
            @Override
            public byte[] read(String path) throws IOException {
                File f = new File(root, path).getCanonicalFile();
                if (!f.getPath().startsWith(root.getPath()) || !f.isFile()) return null;
                try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                    return MapperServer.readAll(in);
                }
            }
        }, new File(dataDir), port);
        int bound = server.start();
        List<String> ips = MapperServer.lanAddresses();
        String host = ips.isEmpty() ? "localhost" : ips.get(0);
        System.out.println("Projection Mapper (java) on http://" + host + ":" + bound + "/  (projector: /display.html)");
        Thread.currentThread().join();
    }

    private static String arg(String[] args, String name, String def) {
        for (int i = 0; i < args.length - 1; i++) if (args[i].equals("--" + name)) return args[i + 1];
        return def;
    }
}
