// Sound-reactive mode, end to end: the phone page hops to https (the only place
// browsers allow the microphone), listens to a (fake) microphone, streams
// levels through the server, and the projector makes a reacting shape pulse.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, devices } from 'playwright';
import { startServer, SERVERS } from './harness.mjs';

const LAUNCH = {
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-proxy-server'], // talk to the LAN address directly, like a phone would
};
if (fs.existsSync('/opt/pw-browsers/chromium') && !process.env.PLAYWRIGHT_BROWSERS_PATH) LAUNCH.executablePath = '/opt/pw-browsers/chromium';
// Reach the LAN address directly, like a phone on the same Wi-Fi (sandboxed CI
// environments may otherwise route it through an HTTP proxy).
LAUNCH.env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_proxy$/i.test(k)));

for (const kind of SERVERS) {
  describe(`sound mode via ${kind} server`, () => {
    let srv, browser, tv, ctx;
    before(async () => {
      srv = await startServer(kind);
      browser = await chromium.launch(LAUNCH);
      tv = await browser.newPage({ viewport: { width: 960, height: 540 } });
      await tv.goto(srv.base + '/display.html');
      await tv.waitForFunction(() => window.__pm && window.__pm.link.connected);
      ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true, permissions: ['microphone'] });
    });
    after(async () => { await browser.close(); await srv.stop(); });

    test('server offers https with the same app and API', async () => {
      assert.ok(srv.httpsPort > 0, 'https port advertised in /api/info');
      const page = await ctx.newPage();
      await page.goto(srv.secureBase + '/');
      await page.waitForFunction(() => window.__pm && window.__pm.synced === true);
      assert.equal(await page.evaluate(() => window.isSecureContext), true);
      await page.close();
    });

    test('on the plain http page, the mic button hops to the secure page', async () => {
      // Phones use the LAN address (plain http there is NOT a secure context;
      // 127.0.0.1 would be, so use the address the projector advertises).
      const ip = (await (await fetch(srv.base + '/api/info')).json()).ips[0];
      if (!ip) return; // no LAN interface in this environment
      const page = await ctx.newPage();
      await page.goto(`http://${ip}:${srv.port}/`);
      await page.waitForFunction(() => window.__pm && window.__pm.synced === true);
      assert.equal(await page.evaluate(() => window.isSecureContext), false);
      page.once('dialog', (d) => d.accept());
      await Promise.all([page.waitForURL(/^https:.*\?mic=1$/), page.click('#micBtn')]);
      assert.equal(page.url(), `https://${ip}:${srv.httpsPort}/?mic=1`);
      await page.waitForFunction(() => document.getElementById('micBtn').classList.contains('attention'));
      await page.close();
    });

    test('microphone levels reach the projector and make a shape pulse', async () => {
      const page = await ctx.newPage();
      await page.goto(srv.secureBase + '/?mic=1');
      await page.waitForFunction(() => window.__pm && window.__pm.synced === true);
      await page.evaluate(async () => {
        const { createShape, makeContent } = await import('/js/state.js');
        const s = createShape('rect', [], window.__pm.aspect);
        s.points = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
        s.content = makeContent('solid', { c1: '#ffffff', react: 1, reactMode: 'pulse' });
        window.__pm.commit({ type: 'replace', state: { shapes: [s] } });
      });
      await page.click('#micBtn');
      await page.waitForFunction(() => document.getElementById('micBtn').classList.contains('on'));
      // Chrome's fake microphone beeps; the projector should hear it.
      await tv.waitForFunction(() => window.__pm.renderer.audio.active && window.__pm.renderer.audio.level > 0.05, null, { timeout: 15000 });
      const samples = [];
      for (let i = 0; i < 40; i++) {
        samples.push((await tv.evaluate(() => window.__pm.renderer.sample(0.5, 0.5)))[0]);
        await tv.waitForTimeout(60);
      }
      const lo = Math.min(...samples), hi = Math.max(...samples);
      assert.ok(hi - lo > 60, `brightness follows the sound (min ${lo}, max ${hi})`);
      // Turning the mic off returns the shape to full brightness.
      await page.click('#micBtn');
      await tv.waitForFunction(() => !window.__pm.renderer.audio.active || window.__pm.renderer.audio.level < 0.01, null, { timeout: 5000 });
      await tv.waitForFunction(() => window.__pm.renderer.sample(0.5, 0.5)[0] > 240, null, { timeout: 5000 });
      await page.close();
    });
  });
}
