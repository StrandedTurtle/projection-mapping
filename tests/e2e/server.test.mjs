// HTTP + WebSocket contract, run against BOTH the Node server and the Java
// server embedded in the Android TV app.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, SERVERS, wsClient } from './harness.mjs';

for (const kind of SERVERS) {
  describe(`${kind} server`, () => {
    let srv;
    before(async () => { srv = await startServer(kind); });
    after(async () => { await srv.stop(); });

    test('serves the web app', async () => {
      for (const [p, needle] of [['/', 'Projection Mapper'], ['/display.html', 'Scan to start'], ['/display', 'Scan to start'],
        ['/js/engine/renderer.js', 'class Renderer'], ['/css/controller.css', '--accent']]) {
        const r = await fetch(srv.base + p);
        assert.equal(r.status, 200, p);
        assert.ok((await r.text()).includes(needle), p);
      }
      const js = await fetch(srv.base + '/js/state.js');
      assert.match(js.headers.get('content-type'), /javascript/);
      assert.equal((await fetch(srv.base + '/nope.html')).status, 404);
      assert.notEqual((await fetch(srv.base + '/..%2f..%2fetc/passwd')).status, 200);
    });

    test('/api/info', async () => {
      const info = await (await fetch(srv.base + '/api/info')).json();
      assert.equal(info.port, srv.port);
      assert.ok(Array.isArray(info.ips));
      assert.equal(info.server, kind);
    });

    test('state round trip', async () => {
      assert.equal(await (await fetch(srv.base + '/api/state')).text(), 'null');
      const state = { shapes: [{ id: 'a', points: [[0, 0], [1, 0], [1, 1]] }], name: 'héllo ✨' };
      const put = await fetch(srv.base + '/api/state', { method: 'PUT', body: JSON.stringify(state), headers: { 'Content-Type': 'application/json' } });
      assert.equal(put.status, 200);
      assert.deepEqual(await (await fetch(srv.base + '/api/state')).json(), state);
      const bad = await fetch(srv.base + '/api/state', { method: 'PUT', body: 'not json' });
      assert.equal(bad.status, 400);
    });

    test('media upload, list, range, delete', async () => {
      const bytes = new Uint8Array(200000).map((_, i) => i % 251);
      const up = await fetch(srv.base + '/api/media?name=' + encodeURIComponent('My Clip.mp4'), { method: 'POST', body: bytes });
      assert.equal(up.status, 200);
      const { url, name } = await up.json();
      assert.match(url, /^\/media\/[a-f0-9]+-My_Clip\.mp4$/);
      assert.equal(name, 'My_Clip.mp4');
      const list = await (await fetch(srv.base + '/api/media')).json();
      assert.equal(list.length, 1);
      assert.equal(list[0].kind, 'video');
      assert.equal(list[0].size, bytes.length);

      const full = new Uint8Array(await (await fetch(srv.base + url)).arrayBuffer());
      assert.deepEqual(full, bytes);
      const part = await fetch(srv.base + url, { headers: { Range: 'bytes=1000-1999' } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${bytes.length}`);
      assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.slice(1000, 2000));
      const tail = await fetch(srv.base + url, { headers: { Range: 'bytes=-10' } });
      assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), bytes.slice(-10));
      const open = await fetch(srv.base + url, { headers: { Range: 'bytes=199990-' } });
      assert.equal((await open.arrayBuffer()).byteLength, 10);

      const rejected = await fetch(srv.base + '/api/media?name=evil.exe', { method: 'POST', body: 'x' });
      assert.equal(rejected.status, 400);

      await fetch(srv.base + '/api/media/' + url.split('/').pop(), { method: 'DELETE' });
      assert.equal((await (await fetch(srv.base + '/api/media')).json()).length, 0);
      assert.equal((await fetch(srv.base + url)).status, 404);
    });

    test('websocket relay + peer counts', async () => {
      const tv = wsClient(srv.base, 'display');
      await tv.opened;
      await tv.waitFor((m) => m.t === 'peers' && m.displays === 1 && m.controllers === 0);
      const phone = wsClient(srv.base, 'controller');
      await phone.opened;
      await tv.waitFor((m) => m.t === 'peers' && m.controllers === 1);
      await phone.waitFor((m) => m.t === 'peers' && m.displays === 1 && m.controllers === 1);

      phone.send({ t: 'hello' });
      await tv.waitFor((m) => m.t === 'hello');
      // big message (> 64KB) exercises extended frame lengths both ways
      const big = { t: 'sync', state: { blob: 'x'.repeat(100000), emoji: '🎃' } };
      tv.send(big);
      const got = await phone.waitFor((m) => m.t === 'sync');
      assert.equal(got.state.blob.length, 100000);
      assert.equal(got.state.emoji, '🎃');
      // pings are not relayed; sender does not get its own messages
      phone.send('{"t":"ping"}');
      phone.send({ t: 'op', op: { type: 'setGlobal', patch: { brightness: 0.4 } } });
      await tv.waitFor((m) => m.t === 'op');
      assert.equal(tv.messages.filter((m) => m.t === 'ping').length, 0);
      assert.equal(phone.messages.filter((m) => m.t === 'op').length, 0);

      phone.close();
      await tv.waitFor((m) => m.t === 'peers' && m.controllers === 0);
      tv.close();
    });
  });
}
