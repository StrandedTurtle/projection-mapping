// Starts either server implementation on a free port with a throwaway data dir.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JAVA_SRC = path.join(ROOT, 'android/server/src/main/java');
const JAVA_RES = path.join(ROOT, 'android/server/src/main/resources');

export function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

let javaClasses = null;
function compileJava() {
  if (javaClasses) return javaClasses;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-java-'));
  const files = fs.readdirSync(path.join(JAVA_SRC, 'app/projectionmapper/server')).map((f) => path.join(JAVA_SRC, 'app/projectionmapper/server', f));
  execFileSync('javac', ['--release', '8', '-Xlint:-options', '-d', out, ...files], { stdio: 'pipe' });
  javaClasses = out;
  return out;
}

export function hasJava() {
  try { execFileSync('javac', ['-version'], { stdio: 'pipe' }); return true; } catch (e) { return false; }
}

export async function startServer(kind) {
  const port = await freePort();
  const httpsPort = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-data-'));
  const web = path.join(ROOT, 'web');
  let proc;
  if (kind === 'java') {
    const cp = compileJava();
    proc = spawn('java', ['-cp', cp + path.delimiter + JAVA_RES, 'app.projectionmapper.server.Main', '--web', web, '--data', data, '--port', String(port), '--https-port', String(httpsPort)], { stdio: 'pipe' });
  } else {
    proc = spawn(process.execPath, [path.join(ROOT, 'server/server.js'), '--web', web, '--data', data, '--port', String(port), '--https-port', String(httpsPort)], { stdio: 'pipe' });
  }
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/info'); if (r.ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 99) throw new Error(`${kind} server did not start:\n${log}`);
  }
  const info = await (await fetch(base + '/api/info')).json();
  return {
    kind, port, base, data, httpsPort: info.httpsPort, secureBase: `https://127.0.0.1:${info.httpsPort}`,
    get log() { return log; },
    async stop() {
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
      fs.rmSync(data, { recursive: true, force: true });
    },
  };
}

export const SERVERS = hasJava() ? ['node', 'java'] : ['node'];

/** Open a WebSocket and collect messages. */
export function wsClient(base, role) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws?role=' + role);
  const messages = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    messages.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return {
    ws, messages, opened,
    send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
    waitFor(pred, ms = 3000) {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timeout waiting for message; got ' + JSON.stringify(messages))), ms);
      });
    },
    close: () => ws.close(),
  };
}
