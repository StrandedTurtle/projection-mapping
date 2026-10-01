// Rough GPU cost benchmark: renders each effect full-screen at 1920x1080 and
// reports ms/frame (reading back a pixel forces the GPU to finish each frame).
// Usage: node tools/bench.mjs [baseUrl] [effect,effect...|all] [fxScale]
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:8099';
const only = process.argv[3] && process.argv[3] !== 'all' ? process.argv[3].split(',') : null;
const fxScale = process.argv[4] ? +process.argv[4] : 0.5;
const launch = { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] };
if (fs.existsSync('/opt/pw-browsers/chromium')) launch.executablePath = '/opt/pw-browsers/chromium';
const b = await chromium.launch(launch);
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await p.goto(base + '/js/net.js');
const res = await p.evaluate(async ([only, fxScale, NOAA]) => {
  const { Renderer } = await import('/js/engine/renderer.js');
  const { EFFECTS } = await import('/js/engine/effects.js');
  const { makeContent } = await import('/js/state.js');
  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
  document.body.appendChild(c);
  const r = new Renderer(c, { maxDpr: 1, maxWidth: 1920, fxScale, antialias: !NOAA });
  const state = { shapes: [], scenes: [], playlist: {}, global: { brightness: 1, background: '#000000' } };
  r.setState(state);
  r.warmup();
  const px = new Uint8Array(4);
  const sync = () => r.gl.readPixels(0, 0, 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, px);
  const out = {};
  for (const fx of EFFECTS) {
    if (only && !only.includes(fx.id)) continue;
    state.shapes = [{ id: 'a', type: 'quad', visible: true, opacity: 1, feather: 0, mask: 'none',
      points: [[0, 0], [1, 0], [1, 1], [0, 1]], content: makeContent(fx.id) }];
    for (let i = 0; i < 3; i++) { r.render(performance.now()); sync(); }
    const t0 = performance.now(); let n = 0;
    while (performance.now() - t0 < 700) { r.render(performance.now()); sync(); n++; }
    out[fx.id] = +((performance.now() - t0) / n).toFixed(1);
  }
  return { size: [c.width, c.height], out };
}, [only, fxScale, !!process.env.NOAA]);
await b.close();
const sorted = Object.entries(res.out).sort((a, b) => b[1] - a[1]);
console.log(`canvas ${res.size.join('x')} fxScale ${fxScale}  (ms per frame, software GPU; compare relatively)`);
for (const [k, v] of sorted) console.log(`  ${k.padEnd(10)} ${String(v).padStart(7)} ms  ${'█'.repeat(Math.min(60, Math.round(v / sorted[sorted.length - 1][1])))}`);
