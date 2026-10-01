// Effect library. Each effect is a GLSL snippet defining `vec3 fx(vec2 uv)`.
//
// Available inside fx():
//   uv        0..1 across the surface (0,0 = top-left, perspective-correct for quads)
//   u_t       per-surface animation time (already multiplied by the speed slider)
//   u_c1..c3  colours (vec3)
//   u_scale   pattern size multiplier
//   u_amount  effect-specific 0..1 slider
//   u_angle   direction in radians
//   u_aspect  surface width / height (for round, non-stretched patterns)
//   u_seed    random 0..1 per surface, so copies don't look identical
//   edge()    normalised distance to the surface edge (only if needsEdge)
// Effects marked heavy:true are rendered at reduced resolution into a texture
// (they must not use edge()); soft/organic looks hide the lower resolution.
// minRes keeps effects with fine detail (eyes, sparkles) from getting blurry.
// Helpers: hash, hash2, noise, fbm, hsv2rgb, rot, ramp3, P(uv) isotropic coords.

import { PACK_EFFECTS } from './effects-packs.js';

export const PARAMS = {
  c1: { label: 'Color 1', type: 'color' },
  c2: { label: 'Color 2', type: 'color' },
  c3: { label: 'Color 3', type: 'color' },
  speed: { label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05 },
  scale: { label: 'Size', type: 'range', min: 0.2, max: 4, step: 0.05 },
  amount: { label: 'Amount', type: 'range', min: 0, max: 1, step: 0.01 },
  angle: { label: 'Direction', type: 'range', min: 0, max: 360, step: 5 },
};

const BASE_EFFECTS = [
  {
    id: 'solid', name: 'Solid', tags: ['basic'],
    params: ['c1'], defaults: { c1: '#ffffff' },
    glsl: `vec3 fx(vec2 uv){ return u_c1; }`,
  },
  {
    id: 'gradient', name: 'Gradient', tags: ['basic', 'calm'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'angle'],
    defaults: { c1: '#ff0080', c2: '#7928ca', c3: '#0070f3', speed: 0.5, scale: 1, angle: 0 },
    glsl: `vec3 fx(vec2 uv){
      vec2 d = vec2(cos(u_angle), sin(u_angle));
      float f = dot(P(uv), d) * 0.5 * u_scale - u_t * 0.1;
      return ramp3loop(fract(f));
    }`,
  },
  {
    id: 'rainbow', name: 'Rainbow', tags: ['party'],
    params: ['speed', 'scale', 'angle', 'amount'],
    defaults: { speed: 1, scale: 1, angle: 0, amount: 1 },
    labels: { amount: 'Saturation' },
    glsl: `vec3 fx(vec2 uv){
      vec2 d = vec2(cos(u_angle), sin(u_angle));
      float h = dot(P(uv), d) * 0.5 * u_scale - u_t * 0.15;
      return hsv2rgb(vec3(fract(h), u_amount, 1.0));
    }`,
  },
  {
    id: 'cycle', name: 'Color Cycle', tags: ['party', 'basic'],
    params: ['c1', 'c2', 'c3', 'speed', 'amount'],
    defaults: { c1: '#ff0000', c2: '#00ff00', c3: '#0000ff', speed: 1, amount: 0 },
    labels: { amount: 'Hard cuts' },
    glsl: `vec3 fx(vec2 uv){
      float f = fract(u_t * 0.15);
      float s = f * 3.0; float i = floor(s); float k = fract(s);
      float edgeW = mix(1.0, 0.02, u_amount);
      k = smoothstep(1.0 - edgeW, 1.0, k);
      vec3 a = i < 0.5 ? u_c1 : (i < 1.5 ? u_c2 : u_c3);
      vec3 b = i < 0.5 ? u_c2 : (i < 1.5 ? u_c3 : u_c1);
      return mix(a, b, k);
    }`,
  },
  {
    id: 'pulse', name: 'Breathe', tags: ['calm', 'basic'],
    params: ['c1', 'c2', 'speed', 'amount'],
    defaults: { c1: '#ff6a00', c2: '#000000', speed: 1, amount: 1 },
    labels: { amount: 'Depth' },
    glsl: `vec3 fx(vec2 uv){
      float s = 0.5 + 0.5 * sin(u_t * 2.0);
      return mix(u_c1, u_c2, s * u_amount);
    }`,
  },
  {
    id: 'strobe', name: 'Strobe', tags: ['party'],
    params: ['c1', 'c2', 'speed', 'amount'],
    defaults: { c1: '#ffffff', c2: '#000000', speed: 1, amount: 0.15 },
    labels: { amount: 'Flash length' },
    glsl: `vec3 fx(vec2 uv){
      float on = step(fract(u_t * 4.0), max(u_amount, 0.02));
      return mix(u_c2, u_c1, on);
    }`,
  },
  {
    id: 'plasma', heavy: true, name: 'Plasma', tags: ['party', 'calm'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale'],
    defaults: { c1: '#ff006e', c2: '#8338ec', c3: '#3a86ff', speed: 1, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 6.0 * u_scale;
      float t = u_t;
      float v = sin(p.x + t) + sin(p.y * 1.1 + t * 1.3) + sin((p.x + p.y) * 0.7 + t * 0.7)
              + sin(length(p + vec2(sin(t * 0.3), cos(t * 0.4)) * 3.0) + t * 1.7);
      return ramp3loop(fract(v * 0.125 + 0.5));
    }`,
  },
  {
    id: 'fire', heavy: true, name: 'Fire', tags: ['halloween'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ff1e00', c2: '#ff9d00', c3: '#fff3b0', speed: 1, scale: 1, amount: 0.5 },
    labels: { amount: 'Height' },
    glsl: `vec3 fx(vec2 uv){
      float h = 1.0 - uv.y;
      vec2 q = vec2(P(uv).x * 3.0 * u_scale, h * 3.0 * u_scale);
      float n = fbm(vec2(q.x + u_seed * 10.0, q.y - u_t * 1.6));
      n += 0.5 * fbm(vec2(q.x * 2.0, q.y * 2.0 - u_t * 2.5));
      float v = clamp(n * 1.25 - h * (2.2 - 1.8 * u_amount) + 0.15, 0.0, 1.0);
      vec3 c = mix(vec3(0.0), u_c1, smoothstep(0.0, 0.35, v));
      c = mix(c, u_c2, smoothstep(0.3, 0.7, v));
      c = mix(c, u_c3, smoothstep(0.65, 1.0, v));
      return c;
    }`,
  },
  {
    id: 'water', heavy: true, name: 'Water', tags: ['calm'],
    params: ['c1', 'c2', 'speed', 'scale'],
    defaults: { c1: '#003366', c2: '#7fdbff', speed: 0.6, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 6.28318 * u_scale * 0.8 - 250.0;
      vec2 i = p; float c = 1.0; float inten = 0.005;
      for (int n = 0; n < 4; n++) {
        float t = u_t * 0.5 * (1.0 - (3.5 / float(n + 1)));
        i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
        c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
      }
      c /= 4.0; c = 1.17 - pow(c, 1.4);
      float v = clamp(pow(abs(c), 8.0), 0.0, 1.0);
      return mix(u_c1, u_c2, v);
    }`,
  },
  {
    id: 'stripes', name: 'Stripes', tags: ['christmas', 'party'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount', 'angle'],
    defaults: { c1: '#ff0000', c2: '#ffffff', speed: 1, scale: 1, amount: 0.5, angle: 45 },
    labels: { amount: 'Width' },
    glsl: `vec3 fx(vec2 uv){
      vec2 d = vec2(cos(u_angle), sin(u_angle));
      float f = fract(dot(P(uv), d) * 4.0 * u_scale - u_t * 0.5);
      float w = 0.02;
      float m = smoothstep(0.0, w, f) * (1.0 - smoothstep(u_amount, u_amount + w, f));
      return mix(u_c2, u_c1, m);
    }`,
  },
  {
    id: 'checker', name: 'Checker', tags: ['party'],
    params: ['c1', 'c2', 'speed', 'scale'],
    defaults: { c1: '#ffffff', c2: '#000000', speed: 1, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 c = floor(P(uv) * 4.0 * u_scale + 100.0);
      float m = mod(c.x + c.y + floor(u_t * 2.0), 2.0);
      return mix(u_c2, u_c1, m);
    }`,
  },
  {
    id: 'sparkle', heavy: true, minRes: 0.5, name: 'Sparkle', tags: ['christmas', 'calm'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#fff4c2', c2: '#000000', speed: 1, scale: 1, amount: 0.5 },
    labels: { amount: 'Density' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 14.0 * u_scale;
      vec2 cell = floor(p); vec2 f = fract(p) - 0.5;
      float r = hash(cell + u_seed);
      vec2 off = (hash2(cell) - 0.5) * 0.6;
      float d = length(f - off);
      float tw = pow(max(0.0, sin(u_t * (1.0 + r * 3.0) + r * 6.2831)), 12.0);
      float on = step(1.0 - u_amount, hash(cell * 1.7 + 3.1));
      float star = smoothstep(0.18, 0.0, d) + 0.35 * smoothstep(0.03, 0.0, min(abs(f.x - off.x), abs(f.y - off.y))) * smoothstep(0.4, 0.0, d);
      return u_c2 + u_c1 * star * tw * on * 1.5;
    }`,
  },
  {
    id: 'clouds', heavy: true, name: 'Clouds', tags: ['calm', 'halloween'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ffffff', c2: '#1b2a6b', speed: 0.5, scale: 1, amount: 0.5 },
    labels: { amount: 'Contrast' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 3.0 * u_scale + vec2(u_t * 0.2, u_t * 0.05) + u_seed * 20.0;
      float n = fbm(p + fbm(p + u_t * 0.1));
      n = smoothstep(0.5 - 0.5 * (1.0 - u_amount) - 0.1, 0.5 + 0.5 * (1.0 - u_amount) + 0.1, n);
      return mix(u_c2, u_c1, n);
    }`,
  },
  {
    id: 'sweep', name: 'Scanner', tags: ['party', 'architecture'],
    params: ['c1', 'c2', 'speed', 'amount', 'angle'],
    defaults: { c1: '#00e5ff', c2: '#000000', speed: 1, amount: 0.15, angle: 0 },
    labels: { amount: 'Beam width' },
    glsl: `vec3 fx(vec2 uv){
      vec2 d = vec2(cos(u_angle), sin(u_angle));
      float x = dot(uv - 0.5, d) / (abs(d.x) + abs(d.y)) + 0.5;
      float pos = abs(fract(u_t * 0.25) * 2.0 - 1.0) * 1.2 - 0.1;
      float w = max(u_amount, 0.01) * 0.5;
      float i = smoothstep(w, 0.0, abs(x - pos));
      return mix(u_c2, u_c1, i);
    }`,
  },
  {
    id: 'spiral', name: 'Spiral', tags: ['party', 'halloween'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ffffff', c2: '#000000', speed: 1, scale: 1, amount: 0.3 },
    labels: { amount: 'Arms' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv);
      float a = atan(p.y, p.x) / 6.28318;
      float r = length(p);
      float arms = 1.0 + floor(u_amount * 7.0);
      float f = fract(a * arms + r * 3.0 * u_scale - u_t * 0.5);
      return mix(u_c2, u_c1, smoothstep(0.45, 0.5, f) - smoothstep(0.95, 1.0, f));
    }`,
  },
  {
    id: 'ripple', name: 'Ripples', tags: ['calm'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#00ffc8', c2: '#001a33', speed: 1, scale: 1, amount: 0.4 },
    labels: { amount: 'Sharpness' },
    glsl: `vec3 fx(vec2 uv){
      float r = length(P(uv));
      float f = 0.5 + 0.5 * sin(r * 25.0 * u_scale - u_t * 4.0);
      return mix(u_c2, u_c1, pow(f, 1.0 + u_amount * 8.0));
    }`,
  },
  {
    id: 'glow', name: 'Edge Glow', tags: ['architecture', 'christmas'], needsEdge: true,
    params: ['c1', 'c2', 'speed', 'amount'],
    defaults: { c1: '#ffffff', c2: '#000000', speed: 0.5, amount: 0.25 },
    labels: { amount: 'Glow width' },
    glsl: `vec3 fx(vec2 uv){
      float e = edge();
      float w = 0.01 + u_amount * 0.25;
      float g = exp(-e / w * 2.5);
      g *= 0.8 + 0.2 * sin(u_t * 3.0);
      return mix(u_c2, u_c1, clamp(g, 0.0, 1.0));
    }`,
  },
  {
    id: 'chase', name: 'Marquee Lights', tags: ['christmas', 'party'], needsEdge: true,
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ff2020', c2: '#20ff40', c3: '#000000', speed: 1, scale: 1, amount: 0.12 },
    labels: { amount: 'Border width', scale: 'Bulb count' },
    glsl: `vec3 fx(vec2 uv){
      float e = edge();
      float band = max(u_amount, 0.02) * 0.5;
      vec2 p = uv - 0.5;
      float s = atan(p.y, p.x) / 6.28318 + 0.5;
      float n = floor(16.0 * u_scale) * 2.0;
      float k = s * n;
      float idx = floor(k);
      vec2 cellP = vec2(fract(k) - 0.5, (e / band) - 0.5);
      float bulb = smoothstep(0.45, 0.2, length(cellP * vec2(1.0, 1.0)));
      float inBand = step(e, band);
      float on = step(0.5, fract((idx - floor(u_t * 3.0)) / 3.0 + 0.001) );
      vec3 col = mod(idx, 2.0) < 1.0 ? u_c1 : u_c2;
      return mix(u_c3, col * (0.25 + 0.75 * on), bulb * inBand);
    }`,
  },
  {
    id: 'lightning', heavy: true, name: 'Storm', tags: ['halloween'],
    params: ['c1', 'c2', 'speed', 'amount'],
    defaults: { c1: '#cfd8ff', c2: '#0a0a1a', speed: 1, amount: 0.3 },
    labels: { amount: 'Frequency' },
    glsl: `vec3 fx(vec2 uv){
      float t = u_t + u_seed * 17.0;
      float slot = floor(t * 3.0);
      float strike = step(1.0 - u_amount * 0.4, hash(vec2(slot, u_seed)));
      float ph = fract(t * 3.0);
      float flash = strike * (exp(-ph * 8.0) + 0.6 * exp(-abs(ph - 0.35) * 30.0));
      float cl = fbm(P(uv) * 2.5 + vec2(t * 0.05, 0.0));
      return u_c2 * (0.6 + 0.8 * cl) + u_c1 * flash * (0.4 + cl);
    }`,
  },
  {
    id: 'snow', heavy: true, minRes: 0.45, name: 'Snowfall', tags: ['christmas', 'calm'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ffffff', c2: '#0b1a3a', speed: 1, scale: 1, amount: 0.6 },
    labels: { amount: 'Density' },
    glsl: `vec3 fx(vec2 uv){
      vec3 col = u_c2;
      for (int l = 0; l < 3; l++) {
        float fl = float(l);
        float sc = (4.0 + fl * 3.0) * u_scale;
        vec2 p = P(uv) * sc;
        p.y -= u_t * (0.6 + fl * 0.35);
        p.x += sin(u_t * 0.7 + p.y * 0.5 + fl) * 0.3;
        vec2 cell = floor(p); vec2 f = fract(p) - 0.5;
        float r = hash(cell + fl * 13.0);
        vec2 off = (hash2(cell + fl * 7.0) - 0.5) * 0.7;
        float present = step(1.0 - u_amount, r);
        float d = length(f - off);
        float size = 0.05 + 0.06 * (2.0 - fl) / 2.0;
        col = mix(col, u_c1, present * smoothstep(size, size * 0.3, d) * (0.5 + 0.25 * fl));
      }
      return col;
    }`,
  },
  {
    id: 'eyes', heavy: true, minRes: 0.6, name: 'Spooky Eyes', tags: ['halloween'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ffdd00', c2: '#000000', speed: 1, scale: 1, amount: 0.35 },
    labels: { amount: 'How many' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 2.0 * u_scale;
      vec2 cell = floor(p); vec2 f = fract(p);
      float r = hash(cell + u_seed * 3.0);
      if (r > u_amount) return u_c2;
      vec2 c = vec2(0.5, 0.5) + (hash2(cell + 5.0) - 0.5) * vec2(0.2, 0.4);
      float per = 3.0 + r * 5.0;
      float ph = fract(u_t / per + r * 7.0);
      float open = smoothstep(0.0, 0.03, abs(ph - 0.5)) ; // blink
      float awake = smoothstep(0.0, 0.1, sin(u_t * 0.3 + r * 40.0) + 0.2);
      open *= awake;
      vec3 col = u_c2;
      for (int k = 0; k < 2; k++) {
        vec2 e = c + vec2(k == 0 ? -0.17 : 0.17, 0.0);
        vec2 d = (f - e) / vec2(0.13, 0.08 * open + 0.0001);
        float eye = smoothstep(1.0, 0.8, length(d));
        float pupil = smoothstep(0.3, 0.2, abs((f.x - e.x) / 0.13 - sin(u_t * 0.5 + r * 9.0) * 0.4));
        col = mix(col, u_c1 * (1.0 - 0.9 * pupil), eye * step(0.01, open));
        col += u_c1 * 0.3 * smoothstep(2.2, 0.0, length((f - e) / vec2(0.18, 0.13))) * open;
      }
      return col;
    }`,
  },
  {
    id: 'matrix', heavy: true, minRes: 0.5, name: 'Digital Rain', tags: ['party'],
    params: ['c1', 'c2', 'speed', 'scale'],
    defaults: { c1: '#00ff66', c2: '#000000', speed: 1, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * vec2(20.0, 14.0) * u_scale;
      float col = floor(p.x);
      float r = hash(vec2(col, u_seed));
      float y = p.y + u_t * (3.0 + r * 5.0) * -1.0 + r * 50.0;
      float head = fract(-y / 20.0);
      float tail = pow(head, 6.0);
      vec2 g = floor(vec2(p.x, y));
      float ch = step(0.35, hash(g + floor(u_t * 4.0 + hash(g) * 10.0)));
      vec2 cf = fract(vec2(p.x, y));
      float glyph = step(0.15, cf.x) * step(cf.x, 0.85) * step(0.1, cf.y) * step(cf.y, 0.9);
      float b = tail * ch * glyph;
      return mix(u_c2, u_c1, b) + vec3(0.6) * step(0.97, head) * glyph;
    }`,
  },
  {
    id: 'dots', name: 'Dot Wave', tags: ['architecture', 'party'],
    params: ['c1', 'c2', 'speed', 'scale', 'angle'],
    defaults: { c1: '#ffffff', c2: '#000000', speed: 1, scale: 1, angle: 0 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 10.0 * u_scale;
      vec2 cell = floor(p) + 0.5;
      vec2 d = vec2(cos(u_angle), sin(u_angle));
      float w = 0.5 + 0.5 * sin(dot(cell, d) * 0.6 - u_t * 3.0);
      float r = 0.08 + 0.37 * w;
      float m = smoothstep(r, r - 0.06, length(p - cell));
      return mix(u_c2, u_c1, m);
    }`,
  },
  {
    id: 'noise', name: 'TV Static', tags: ['halloween'],
    params: ['c1', 'c2', 'speed', 'scale'],
    defaults: { c1: '#ffffff', c2: '#000000', speed: 1, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = floor(P(uv) * 160.0 / u_scale);
      float n = hash(p + floor(u_t * 24.0) * 1.31);
      float roll = 0.85 + 0.15 * sin(uv.y * 20.0 - u_t * 6.0);
      return mix(u_c2, u_c1, n * roll);
    }`,
  },
  {
    id: 'lava', heavy: true, name: 'Lava Lamp', tags: ['calm', 'party'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale'],
    defaults: { c1: '#ff3d00', c2: '#ffea00', c3: '#2b0040', speed: 0.6, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 2.0 * u_scale;
      float v = 0.0;
      for (int i = 0; i < 6; i++) {
        float fi = float(i);
        vec2 c = vec2(sin(u_t * 0.3 * (0.5 + hash(vec2(fi, 1.0))) + fi * 2.0) * 0.8,
                      sin(u_t * 0.4 * (0.5 + hash(vec2(fi, 2.0))) + fi * 1.3) * 0.8);
        v += 0.06 / max(dot(p - c, p - c), 0.001);
      }
      float m = smoothstep(0.9, 1.1, v);
      vec3 blob = mix(u_c1, u_c2, clamp(v - 1.0, 0.0, 1.0) * 0.6);
      return mix(u_c3, blob, m);
    }`,
  },
];

export const EFFECTS = [...BASE_EFFECTS, ...PACK_EFFECTS];
export const EFFECT_MAP = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));

export function effectDefaults(id) {
  const e = EFFECT_MAP[id] || EFFECT_MAP.solid;
  return { c1: '#ffffff', c2: '#000000', c3: '#808080', speed: 1, scale: 1, amount: 0.5, angle: 0, ...e.defaults };
}

export function paramLabel(effectId, param) {
  const e = EFFECT_MAP[effectId];
  return (e && e.labels && e.labels[param]) || PARAMS[param].label;
}

export const PRELUDE = `
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 hash2(vec2 p){ float a = hash(p); return vec2(a, hash(p + a + 17.0)); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.02 + 3.1; a *= 0.5; } return v; }
vec3 hsv2rgb(vec3 c){ vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0/3.0, 1.0/3.0)) * 6.0 - 3.0); return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec2 P(vec2 uv){ return (uv - 0.5) * vec2(max(u_aspect, 1.0), max(1.0 / u_aspect, 1.0)) * 2.0; }
vec3 ramp3loop(float f){
  float s = f * 3.0;
  if (s < 1.0) return mix(u_c1, u_c2, smoothstep(0.0, 1.0, s));
  if (s < 2.0) return mix(u_c2, u_c3, smoothstep(0.0, 1.0, s - 1.0));
  return mix(u_c3, u_c1, smoothstep(0.0, 1.0, s - 2.0));
}
`;
