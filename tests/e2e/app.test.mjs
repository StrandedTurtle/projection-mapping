// End-to-end: a real projector page + real phone pages, driven through each
// server implementation. Checks mapping edits sync, pixels actually render,
// themes/effects/media/scenes work and the project survives a restart.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium, devices } from 'playwright';
import { startServer, SERVERS } from './harness.mjs';

const LAUNCH = { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] };
if (fs.existsSync('/opt/pw-browsers/chromium') && !process.env.PLAYWRIGHT_BROWSERS_PATH) LAUNCH.executablePath = '/opt/pw-browsers/chromium';

function solidPNG(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const until = async (fn, ms = 5000, what = 'condition') => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
};

for (const kind of SERVERS) {
  describe(`app via ${kind} server`, () => {
    let srv, browser, tv, phone, phoneCtx, errors, qrBeforePhone;
    const tvState = () => tv.evaluate(() => JSON.parse(JSON.stringify(window.__pm.state)));
    const tvPixel = (x, y) => tv.evaluate(([a, b]) => window.__pm.renderer.sample(a, b), [x, y]);
    const stageBox = async () => phone.locator('#handles').boundingBox();

    before(async () => {
      srv = await startServer(kind);
      browser = await chromium.launch(LAUNCH);
      errors = [];
      tv = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      tv.on('pageerror', (e) => errors.push('tv: ' + e.message));
      tv.on('console', (m) => { if (m.type() === 'error') errors.push('tv: ' + m.text()); });
      await tv.goto(srv.base + '/display.html');
      await tv.waitForFunction(() => window.__pm && window.__pm.link.connected);
      qrBeforePhone = await tv.locator('#connect.show.big').count();
      phoneCtx = await browser.newContext({ ...devices['Pixel 7'] });
      phone = await phoneCtx.newPage();
      phone.on('pageerror', (e) => errors.push('phone: ' + e.message));
      phone.on('console', (m) => { if (m.type() === 'error') errors.push('phone: ' + m.text()); });
      phone.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Spooky' : undefined));
      await phone.goto(srv.base + '/');
      await phone.waitForFunction(() => window.__pm.synced === true);
    });
    after(async () => {
      await browser.close();
      await srv.stop();
    });

    test('projector shows the QR welcome and phone shows connected', async () => {
      assert.equal(await phone.textContent('#statusText'), 'Projector connected');
      assert.equal(await tv.locator('#qr svg').count(), 1);
      assert.equal(qrBeforePhone, 1, 'big QR shown while no phone is connected');
      await until(async () => (await tv.locator('#connect.show').count()) === 0, 3000, 'QR hides when phone connects');
      assert.match(await tv.textContent('#toast'), /Phone connected/);
    });

    test('add a rectangle and it appears (and lights up) on the projector', async () => {
      await phone.click('[data-add=rect]');
      await until(async () => (await tvState()).shapes.length === 1, 3000, 'shape on tv');
      const s = (await tvState()).shapes[0];
      assert.equal(s.type, 'quad');
      const [cx, cy] = [(s.points[0][0] + s.points[2][0]) / 2, (s.points[0][1] + s.points[2][1]) / 2];
      const inside = await tvPixel(cx, cy);
      assert.ok(inside.some((v) => v > 100), 'shape is lit: ' + inside);
      const outside = await tvPixel(0.02, 0.02);
      assert.deepEqual(outside, [0, 0, 0]);
      assert.ok(await tv.locator('#connect.show').count() === 0, 'QR hides once shapes exist and a phone is connected');
    });

    test('drag a corner on the phone moves it on the projector', async () => {
      const before = (await tvState()).shapes[0].points[0];
      const box = await stageBox();
      const sx = box.x + before[0] * box.width, sy = box.y + before[1] * box.height;
      await phone.mouse.move(sx, sy);
      await phone.mouse.down();
      for (let i = 1; i <= 10; i++) await phone.mouse.move(sx - i * 3, sy - i * 2);
      await phone.mouse.up();
      const want = [before[0] - 30 / box.width, before[1] - 20 / box.height];
      await until(async () => {
        const p = (await tvState()).shapes[0].points[0];
        return Math.abs(p[0] - want[0]) < 0.004 && Math.abs(p[1] - want[1]) < 0.004;
      }, 3000, 'corner moved');
      assert.equal(await phone.textContent('#ctxSub'), 'corner 1 of 4');
    });

    test('arrow pad nudges by exact pixels, undo/redo restores', async () => {
      const p0 = (await tvState()).shapes[0].points[0];
      await phone.click('#stepSeg [data-step="25"]');
      await phone.click('.nb.right');
      await phone.click('.nb.right');
      await until(async () => Math.abs((await tvState()).shapes[0].points[0][0] - (p0[0] + 50 / 1920)) < 1e-6, 2000, 'nudge');
      await phone.click('#undoBtn');
      await until(async () => Math.abs((await tvState()).shapes[0].points[0][0] - p0[0]) < 1e-6, 2000, 'undo');
      await phone.click('#redoBtn');
      await until(async () => Math.abs((await tvState()).shapes[0].points[0][0] - (p0[0] + 50 / 1920)) < 1e-6, 2000, 'redo');
    });

    test('pick an effect from the Look tab', async () => {
      await phone.click('[data-tab=look]');
      await phone.click('[data-fx=fire]');
      await until(async () => (await tvState()).shapes[0].content.effect === 'fire', 2000, 'fire');
      await phone.click('[data-fx=solid]');
      await phone.locator('#params .sw[title="#34c759"]').first().click();
      await until(async () => (await tvState()).shapes[0].content.c1 === '#34c759', 2000, 'green');
      const s = (await tvState()).shapes[0];
      const c = [(s.points[0][0] + s.points[2][0]) / 2, (s.points[0][1] + s.points[2][1]) / 2];
      const px = await tvPixel(...c);
      assert.ok(px[1] > 150 && px[0] < 120, 'renders green: ' + px);
    });

    test('blackout and brightness', async () => {
      const s = (await tvState()).shapes[0];
      const c = [(s.points[0][0] + s.points[2][0]) / 2, (s.points[0][1] + s.points[2][1]) / 2];
      await phone.click('#blackoutBtn');
      await until(async () => (await tvState()).global.blackout, 2000, 'blackout');
      assert.deepEqual(await tvPixel(...c), [0, 0, 0]);
      await phone.click('#blackoutBtn');
      await until(async () => !(await tvState()).global.blackout, 2000, 'un-blackout');
      assert.ok((await tvPixel(...c))[1] > 150);
    });

    test('themes re-skin all shapes; second phone stays in sync', async () => {
      await phone.click('[data-tab=shapes]');
      await phone.click('[data-add=triangle]');
      await phone.click('[data-add=circle]');
      await phone.click('[data-tab=scenes]');
      await phone.click('#themeGrid button:has-text("Christmas")');
      await until(async () => (await tvState()).shapes.map((x) => x.content.effect).join() === 'stripes,snow,chase', 3000, 'theme');

      const phone2 = await phoneCtx.newPage();
      await phone2.goto(srv.base + '/');
      await phone2.waitForFunction(() => window.__pm.synced === true);
      const s2 = await phone2.evaluate(() => window.__pm.state.shapes.map((x) => x.content.effect).join());
      assert.equal(s2, 'stripes,snow,chase');
      assert.match(await phone.textContent('#statusText'), /2 phones/);
      await phone2.close();
    });

    test('save a scene, switch look, restore the scene', async () => {
      await phone.click('#saveSceneBtn');
      await until(async () => (await tvState()).scenes.length === 1, 2000, 'scene saved');
      await phone.click('#themeGrid button:has-text("Party")');
      await until(async () => (await tvState()).shapes[0].content.effect === 'rainbow', 2000, 'party');
      await phone.click('#sceneList button[title="Show now"]');
      await until(async () => (await tvState()).shapes[0].content.effect === 'stripes', 2000, 'scene restored');
      assert.equal((await tvState()).scenes[0].name, 'Spooky');
    });

    test('upload an image from the phone and map it onto a shape', async () => {
      const file = path.join(os.tmpdir(), `pm-red-${kind}.png`);
      fs.writeFileSync(file, solidPNG(64, 32, [255, 0, 0]));
      await phone.click('[data-tab=shapes]');
      await phone.click('#shapeList li:last-child'); // back-most = first shape
      await phone.click('[data-tab=look]');
      await phone.click('#kindSeg [data-kind=image]');
      await phone.setInputFiles('#fileInput', file);
      await until(async () => {
        const c = (await tvState()).shapes[0].content;
        return c.kind === 'image' && /\/media\/.+pm-red/.test(c.media);
      }, 5000, 'image assigned');
      const s = (await tvState()).shapes[0];
      const c = [(s.points[0][0] + s.points[2][0]) / 2, (s.points[0][1] + s.points[2][1]) / 2];
      const px = await until(async () => { const p = await tvPixel(...c); return p[0] > 200 && p[1] < 60 ? p : null; }, 5000, 'red pixels');
      assert.ok(px[0] > 200);
      await until(async () => (await phone.locator('.media-item').count()) === 1, 2000, 'media grid');
    });

    test('upload a video from the phone and it plays on a shape', async () => {
      // Record a short all-blue clip to use as the upload.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-vid-'));
      const recCtx = await browser.newContext({ viewport: { width: 320, height: 240 }, recordVideo: { dir, size: { width: 320, height: 240 } } });
      const rec = await recCtx.newPage();
      await rec.setContent('<body style="margin:0;background:#0000ff;height:100vh"></body>');
      await rec.waitForTimeout(1500);
      await recCtx.close();
      const file = path.join(dir, `clip-${kind}.webm`);
      fs.renameSync(await rec.video().path(), file);

      await phone.click('[data-tab=shapes]');
      await phone.locator('#shapeList li').nth(1).click(); // the middle shape
      const id = await phone.evaluate(() => window.__pm.selection.id);
      await phone.click('[data-tab=look]');
      await phone.click('#kindSeg [data-kind=video]');
      await phone.setInputFiles('#fileInput', file);
      await until(async () => {
        const s = (await tvState()).shapes.find((x) => x.id === id);
        return s.content.kind === 'video' && /clip/.test(s.content.media);
      }, 8000, 'video assigned');
      const s = (await tvState()).shapes.find((x) => x.id === id);
      const [cx, cy] = [s.points.reduce((a, p) => a + p[0], 0) / s.points.length, s.points.reduce((a, p) => a + p[1], 0) / s.points.length];
      const px = await until(async () => { const p = await tvPixel(cx, cy); return p[2] > 180 && p[0] < 80 ? p : null; }, 8000, 'blue video pixels');
      assert.ok(px[2] > 180);
      const playing = await tv.evaluate(() => [...window.__pm.renderer.media.values()].some((m) => m.kind === 'video' && !m.el.paused));
      assert.ok(playing, 'video element is playing');
    });

    test('project survives a projector restart', async () => {
      const before = await tvState();
      await tv.waitForTimeout(1200); // debounced save
      await tv.reload();
      await tv.waitForFunction(() => window.__pm && window.__pm.state.shapes.length === 3);
      const afterState = await tvState();
      assert.deepEqual(afterState.shapes.map((s) => s.points), before.shapes.map((s) => s.points));
      assert.equal(afterState.scenes.length, 1);
      // phone re-syncs automatically
      await phone.waitForFunction(() => window.__pm.link.peers.displays === 1);
    });

    test('no errors in either page', () => {
      assert.deepEqual(errors, []);
    });
  });
}
