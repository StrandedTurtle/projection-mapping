#!/usr/bin/env node
// Projection Mapper - desktop server (zero dependencies).
//
// Serves the phone controller (/) and the projector output (/display.html),
// relays live edits over WebSocket (/ws), stores the project (/api/state) and
// uploaded images/videos (/api/media). The Android TV app embeds a Java port of
// this exact same server, so either one works with the same web app.
//
//   node server/server.js [--port 8080] [--data ./data]

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const VERSION = '1.0.0';
const WEB_DIR = path.resolve(arg('web', path.join(__dirname, '..', 'web')));
const DATA_DIR = path.resolve(arg('data', process.env.PM_DATA || path.join(__dirname, '..', 'data')));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = parseInt(arg('port', process.env.PORT || '8080'), 10);
const MAX_STATE = 5 * 1024 * 1024;
const MAX_MEDIA = 1024 * 1024 * 1024;

fs.mkdirSync(MEDIA_DIR, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.mov', '.m4v']);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
    }
  }
  // Prefer typical home-LAN ranges and wifi/ethernet adapters.
  const score = ({ name, ip }) => (ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : ip.startsWith('172.') ? 1 : 0)
    + (/^(wl|wlan|en|eth|wi-?fi)/i.test(name) ? 2 : 0) - (/(docker|veth|br-|vbox|vmnet|utun|tun|tap)/i.test(name) ? 5 : 0);
  return out.sort((a, b) => score(b) - score(a)).map((a) => a.ip);
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-60);
  return base || 'file';
}

/** Serve a file with HTTP Range support (needed for video seeking/looping). */
function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'not found' });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache || 'no-cache' };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
      let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function listMedia() {
  return fs.readdirSync(MEDIA_DIR)
    .filter((f) => MEDIA_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => {
      const st = fs.statSync(path.join(MEDIA_DIR, f));
      const ext = path.extname(f).toLowerCase();
      return {
        url: `/media/${f}`,
        name: f.replace(/^[a-z0-9]+-/, ''),
        size: st.size,
        kind: ['.mp4', '.webm', '.mov', '.m4v'].includes(ext) ? 'video' : 'image',
        mtime: st.mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);

  if (p === '/api/info') {
    return send(res, 200, { app: 'projection-mapper', version: VERSION, port: PORT, ips: lanAddresses(), server: 'node' });
  }
  if (p === '/api/state') {
    if (req.method === 'GET') {
      return fs.readFile(STATE_FILE, (err, buf) => send(res, 200, err ? 'null' : buf));
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req, MAX_STATE);
      try { JSON.parse(body.toString('utf8')); } catch (e) { return send(res, 400, { error: 'invalid json' }); }
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, STATE_FILE);
      return send(res, 200, { ok: true });
    }
  }
  if (p === '/api/media' && req.method === 'GET') return send(res, 200, listMedia());
  if (p === '/api/media' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name'));
    const ext = path.extname(name).toLowerCase();
    if (!MEDIA_EXT.has(ext)) return send(res, 400, { error: 'unsupported file type' });
    const file = `${crypto.randomBytes(4).toString('hex')}-${name}`;
    const dest = path.join(MEDIA_DIR, file);
    const out = fs.createWriteStream(dest);
    let size = 0, failed = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_MEDIA && !failed) { failed = true; req.destroy(); out.destroy(); fs.unlink(dest, () => {}); }
    });
    req.pipe(out);
    out.on('finish', () => { if (!failed) send(res, 200, { url: `/media/${file}`, name, size }); });
    out.on('error', () => { if (!failed) send(res, 500, { error: 'write failed' }); });
    req.on('error', () => fs.unlink(dest, () => {}));
    return;
  }
  if (p.startsWith('/api/media/') && req.method === 'DELETE') {
    const f = path.join(MEDIA_DIR, safeName(p.slice('/api/media/'.length)));
    fs.unlink(f, () => send(res, 200, { ok: true }));
    return;
  }
  if (p.startsWith('/media/')) {
    return serveFile(req, res, path.join(MEDIA_DIR, safeName(p.slice(7))), 'public, max-age=31536000, immutable');
  }

  // Static web app.
  if (p === '/') p = '/index.html';
  if (p === '/display' || p === '/tv') p = '/display.html';
  const file = path.normalize(path.join(WEB_DIR, p));
  if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: 'forbidden' });
  serveFile(req, res, file);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
  });
});

// ---------------------------------------------------------------------------
// Minimal WebSocket relay (RFC 6455). Every text message from one client is
// forwarded to all the others; the server announces peer counts.
const clients = new Set();

function frame(str) {
  const payload = Buffer.from(str, 'utf8');
  const n = payload.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  head[0] = 0x81;
  return Buffer.concat([head, payload]);
}

function control(op, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | op, payload.length]), payload]);
}

function broadcastPeers() {
  let displays = 0, controllers = 0;
  for (const c of clients) { if (c.role === 'display') displays++; else controllers++; }
  const msg = frame(JSON.stringify({ t: 'peers', displays, controllers }));
  for (const c of clients) c.socket.write(msg);
}

function relay(from, text) {
  if (text === '{"t":"ping"}') return;
  const msg = frame(text);
  for (const c of clients) if (c !== from) c.socket.write(msg);
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);
  const client = { socket, role: url.searchParams.get('role') === 'display' ? 'display' : 'controller' };
  clients.add(client);
  broadcastPeers();

  let buf = Buffer.alloc(0);
  let fragments = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 32 * 1024 * 1024) { socket.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(need);
      if (op === 0x8) { socket.end(control(0x8)); return; }
      if (op === 0x9) { socket.write(control(0xA, payload.subarray(0, 125))); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments = [];
          if (op !== 0x2) relay(client, whole.toString('utf8'));
        }
      }
    }
  });
  const drop = () => {
    if (clients.delete(client)) broadcastPeers();
  };
  socket.on('close', drop);
  socket.on('end', drop);
  socket.on('error', drop);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  const host = ips[0] || 'localhost';
  console.log('\n  Projection Mapper is running!\n');
  console.log(`  Projector:  open  http://${host}:${PORT}/display.html  (fullscreen, on the projector)`);
  console.log(`  Phone:      open  http://${host}:${PORT}/  (or scan the QR code shown on the projector)\n`);
  if (ips.length > 1) console.log(`  Other addresses: ${ips.slice(1).join(', ')}\n`);
});

module.exports = server;
