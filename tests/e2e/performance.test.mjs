// Adaptive quality: the projector must notice dropped frames and lower the
// internal resolution of heavy effects (and only then the whole output).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from './harness.mjs';

const LAUNCH = { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] };
if (fs.existsSync('/opt/pw-browsers/chromium') && !process.env.PLAYWRIGHT_BROWSERS_PATH) LAUNCH.executablePath = '/opt/pw-browsers/chromium';

let srv, browser, tv;
before(async () => {
  srv = await startServer('node');
  browser = await chromium.launch(LAUNCH);
  tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await tv.goto(srv.base + '/display.html');
  await tv.waitForFunction(() => window.__pm && window.__pm.link.connected);
});
after(async () => { await browser.close(); await srv.stop(); });

const send = (op) => tv.evaluate(async (op) => {
  // Act like a phone: send the op through the relay server.
  const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws?role=controller');
  await new Promise((r) => { ws.onopen = r; });
  ws.send(JSON.stringify({ t: 'op', op }));
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
}, op);

test('heavy effects render through the low-resolution path and look right', async () => {
  const { makeContent } = await import('../../web/js/state.js');
  await send({ type: 'replace', state: { shapes: [
    { id: 'f', type: 'quad', points: [[0, 0], [0.5, 0], [0.5, 1], [0, 1]], content: makeContent('fire') },
    { id: 'w', type: 'quad', points: [[0.5, 0], [1, 0], [1, 1], [0.5, 1]], content: makeContent('solid', { c1: '#00ff00' }) },
  ] } });
  await tv.waitForFunction(() => window.__pm.state.shapes.length === 2);
  const r = await tv.evaluate(() => {
    const R = window.__pm.renderer;
    R.fxScale = 0.5;
    const fireBottom = R.sample(0.25, 0.97); // hot core of the flames
    const solid = R.sample(0.75, 0.5);
    return { fireBottom, solid, fbos: R.fbos.size, fboW: R.fbos.get('f') && R.fbos.get('f').w };
  });
  assert.equal(r.fbos, 1, 'only the heavy effect uses an offscreen texture');
  assert.ok(r.fboW <= 512, `fire texture is reduced (${r.fboW}px for a ~960px wide shape)`);
  assert.ok(r.fireBottom[0] > 180, 'fire is bright at the bottom: ' + r.fireBottom);
  assert.deepEqual(r.solid, [0, 255, 0]);
});

test('auto quality steps down when frames are too slow, manual setting overrides', async () => {
  const { makeContent } = await import('../../web/js/state.js');
  // Let the projector learn the refresh rate on a cheap scene first.
  await send({ type: 'replace', state: { shapes: [] } });
  await tv.waitForTimeout(1500);
  const full = (id, fx) => ({ id, type: 'quad', points: [[0, 0], [1, 0], [1, 1], [0, 1]], content: makeContent(fx) });
  await send({ type: 'replace', state: { shapes: [full('a', 'clouds'), full('b', 'water'), full('c', 'lava'), full('d', 'snow')] } });
  // The software GPU in CI cannot keep up with this at 1080p: auto must react.
  await tv.waitForFunction(() => window.__pm.perf.level >= 2, null, { timeout: 30000, polling: 250 });
  const auto = await tv.evaluate(() => ({ fx: window.__pm.renderer.fxScale, level: window.__pm.perf.level }));
  assert.ok(auto.fx < 0.6, 'heavy effects use a lower resolution: ' + JSON.stringify(auto));

  await send({ type: 'setGlobal', patch: { quality: 'high', showFps: true } });
  await tv.waitForFunction(() => window.__pm.renderer.fxScale === 1 && window.__pm.renderer.resScale === 1);
  assert.equal(await tv.locator('#fps').isVisible(), true);
  await tv.waitForFunction(() => /fps · high/.test(document.getElementById('fps').textContent), null, { timeout: 5000 });
  await send({ type: 'setGlobal', patch: { quality: 'performance', showFps: false } });
  await tv.waitForFunction(() => window.__pm.renderer.fxScale === 0.25 && window.__pm.renderer.resScale === 0.7);
  assert.equal(await tv.locator('#fps').isVisible(), false);
});

test('overlay layer is removed when there is nothing to draw', async () => {
  await send({ type: 'setGlobal', patch: { showOutlines: false, testPattern: false } });
  await tv.waitForFunction(() => document.getElementById('overlay').style.display === 'none');
  await send({ type: 'setGlobal', patch: { showOutlines: true } });
  await tv.waitForFunction(() => document.getElementById('overlay').style.display === '');
});
