// v1.1 features on a real projector page: curved edges, sequences, text,
// sound reactions, every effect + theme, and the phone UI that drives them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, devices } from 'playwright';
import { startServer } from './harness.mjs';

const LAUNCH = { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] };
if (fs.existsSync('/opt/pw-browsers/chromium') && !process.env.PLAYWRIGHT_BROWSERS_PATH) LAUNCH.executablePath = '/opt/pw-browsers/chromium';

let srv, browser, tv, phone, errors;
const quad = (id, x0, y0, x1, y1, content, extra = {}) => ({
  id, type: 'quad', kind: 'rect', visible: true, opacity: 1, feather: 0, mask: 'none', name: id,
  points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], content, ...extra,
});
// Replace the projector's project directly (as a phone would, through the relay).
const load = (state) => phone.evaluate((s) => window.__pm.commit({ type: 'replace', state: s }), state);
const px = (x, y) => tv.evaluate(([a, b]) => window.__pm.renderer.sample(a, b), [x, y]);
const content = async (effect, o = {}) => phone.evaluate(async ([e, o]) => (await import('/js/state.js')).makeContent(e, o), [effect, o]);

before(async () => {
  srv = await startServer('node');
  browser = await chromium.launch(LAUNCH);
  errors = [];
  tv = await browser.newPage({ viewport: { width: 960, height: 540 } });
  tv.on('pageerror', (e) => errors.push('tv: ' + e.message));
  await tv.goto(srv.base + '/display.html');
  await tv.waitForFunction(() => window.__pm && window.__pm.link.connected);
  phone = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  phone.on('pageerror', (e) => errors.push('phone: ' + e.message));
  phone.on('dialog', (d) => d.accept());
  await phone.goto(srv.base + '/');
  await phone.waitForFunction(() => window.__pm.synced === true);
});
after(async () => { await browser.close(); await srv.stop(); });

test('curved edges: content follows the bend, outside stays dark', async () => {
  const white = await content('solid', { c1: '#ffffff' });
  await load({ shapes: [quad('a', 0.3, 0.4, 0.7, 0.8, white, { curves: [[0, -0.2], [0, 0], [0, 0], [0, 0]] })] });
  await tv.waitForFunction(() => window.__pm.state.shapes[0] && window.__pm.state.shapes[0].curves);
  assert.ok((await px(0.5, 0.25))[0] > 200, 'bulge above the straight top edge is lit');
  assert.deepEqual(await px(0.32, 0.25), [0, 0, 0], 'corner area outside the curve stays dark');
  assert.ok((await px(0.5, 0.6))[0] > 200);
});

test('sequences: chase lights one shape at a time, in left-to-right order', async () => {
  const c = await content('solid', { c1: '#ffffff' });
  await load({
    shapes: [quad('r', 0.7, 0.4, 0.9, 0.6, c), quad('l', 0.1, 0.4, 0.3, 0.6, c), quad('m', 0.4, 0.4, 0.6, 0.6, c)],
    sequence: { enabled: true, mode: 'chase', order: 'ltr', speed: 0.0001, smooth: 0, dim: 0 },
  });
  await tv.waitForFunction(() => window.__pm.state.sequence.enabled);
  const lit = async (t) => {
    await tv.evaluate((t) => { window.__pm.renderer.seqTime = t; }, t);
    return [(await px(0.2, 0.5))[0] > 200, (await px(0.5, 0.5))[0] > 200, (await px(0.8, 0.5))[0] > 200];
  };
  assert.deepEqual(await lit(0.5), [true, false, false]);
  assert.deepEqual(await lit(1.5), [false, true, false]);
  assert.deepEqual(await lit(2.5), [false, false, true]);
  assert.deepEqual(await lit(3.5), [true, false, false], 'wraps around');
});

test('text: still message in the text colour on its background box', async () => {
  const t = await content('solid', { kind: 'text', text: 'HELLO', textMode: 'static', c1: '#ff0000', c2: '#0000ff', size: 0.9 });
  await load({ shapes: [quad('t', 0.1, 0.3, 0.9, 0.7, t)] });
  await tv.waitForFunction(() => window.__pm.state.shapes[0].content.kind === 'text');
  let red = 0, blue = 0;
  for (let i = 0; i <= 40; i++) {
    const [r, , b] = await px(0.15 + i * 0.0175, 0.5);
    if (r > 200 && b < 60) red++;
    if (b > 200 && r < 60) blue++;
  }
  assert.ok(red >= 5, `letters drawn in red (${red})`);
  assert.ok(blue >= 5, `blue background between letters (${blue})`);
});

test('sound reactions: pulse, beat flash and sequences on the beat', async () => {
  const c = await content('solid', { c1: '#ffffff', react: 1, reactMode: 'beat' });
  await load({ shapes: [quad('s', 0.2, 0.2, 0.8, 0.8, c)] });
  await tv.waitForFunction(() => window.__pm.state.shapes[0].content.reactMode === 'beat');
  const audio = (m) => phone.evaluate((m) => window.__pm.link.send({ t: 'audio', ...m }), m);
  await audio({ l: 0.5, b: 0.5, m: 0.2, h: 0.1, beat: 1 });
  await audio({ l: 0.5, b: 0.5, m: 0.2, h: 0.1, beat: 2 });
  await tv.waitForFunction(() => window.__pm.renderer.audio.beats >= 1);
  const flash = (await px(0.5, 0.5))[0];
  await tv.waitForTimeout(700);
  await audio({ l: 0.5, b: 0.5, m: 0.2, h: 0.1, beat: 2 });
  const after = (await px(0.5, 0.5))[0];
  assert.ok(flash > 150 && after < 80, `bright on the beat (${flash}), dark between beats (${after})`);
  // Silence for 1.5s: everything returns to normal brightness.
  await tv.waitForFunction(() => !window.__pm.renderer.audio.active, null, { timeout: 4000 });
  assert.ok((await px(0.5, 0.5))[0] > 240);
});

test('every effect renders without GL errors and every theme applies', async () => {
  const res = await tv.evaluate(async () => {
    const { EFFECTS } = await import('/js/engine/effects.js');
    const { makeContent } = await import('/js/state.js');
    const R = window.__pm.renderer;
    const st = window.__pm.state;
    const bad = [];
    for (const fx of EFFECTS) {
      st.shapes = [{ id: 'x', type: 'quad', visible: true, opacity: 1, feather: 0.2, mask: 'none', points: [[0.1, 0.1], [0.9, 0.12], [0.88, 0.9], [0.12, 0.85]], curves: [[0, -0.05], [0, 0], [0, 0.05], [0, 0]], content: makeContent(fx.id) }];
      for (const q of [1, 0.3]) {
        R.fxScale = q;
        R.render(performance.now());
        const err = R.gl.getError();
        if (err) bad.push(`${fx.id}@${q}: ${err}`);
      }
      if (R.programs.get(fx.id) === null) bad.push(fx.id + ' did not compile');
    }
    return { bad, n: EFFECTS.length };
  });
  assert.deepEqual(res.bad, []);
  assert.ok(res.n >= 50, `${res.n} effects`);

  const { THEMES } = await import('../../web/js/state.js');
  const c = await content('solid');
  await load({ shapes: [quad('a', 0, 0, 0.5, 0.5, c), quad('b', 0.5, 0, 1, 0.5, c), quad('c', 0, 0.5, 0.5, 1, c)] });
  await phone.click('[data-tab=scenes]');
  for (const t of THEMES) {
    await phone.click(`#themeGrid button:has-text("${t.name}")`);
    await tv.waitForFunction((e) => window.__pm.state.shapes[0].content.effect === e, t.looks[0].effect);
  }
});

test('phone UI: sequence controls, text typing and bend handles', async () => {
  const c = await content('solid', { c1: '#ffffff' });
  await load({ shapes: [quad('a', 0.1, 0.3, 0.3, 0.6, c), quad('b', 0.4, 0.3, 0.6, 0.6, c)] });
  await phone.click('[data-tab=scenes]');
  await phone.check('#seqToggle');
  await phone.click('#seqModes [data-mode=build]');
  await phone.selectOption('#seqOrder', 'rtl');
  await tv.waitForFunction(() => { const q = window.__pm.state.sequence; return q.enabled && q.mode === 'build' && q.order === 'rtl'; });

  await phone.evaluate(() => window.__pm.select('a'));
  await phone.click('[data-tab=look]');
  await phone.click('#kindSeg [data-kind=text]');
  await phone.fill('#textSection textarea', 'Trick or treat!');
  await tv.waitForFunction(() => window.__pm.state.shapes[0].content.text === 'Trick or treat!');

  await phone.click('#bendBtn');
  const box = await phone.locator('#handles').boundingBox();
  const h = await phone.evaluate(async () => (await import('/js/engine/geometry.js')).bendHandle(window.__pm.selected(), 1));
  const x = box.x + h[0] * box.width, y = box.y + h[1] * box.height;
  await phone.mouse.move(x, y); await phone.mouse.down();
  for (let i = 1; i <= 6; i++) await phone.mouse.move(x + i * 4, y);
  await phone.mouse.up();
  await tv.waitForFunction(() => { const c = window.__pm.state.shapes[0].curves; return c && c[1][0] > 0.02; });
  await phone.click('#bendTools [data-tool=straighten]');
  await tv.waitForFunction(() => window.__pm.state.shapes[0].curves === null);
});

test('no page errors', () => {
  assert.deepEqual(errors, []);
});
