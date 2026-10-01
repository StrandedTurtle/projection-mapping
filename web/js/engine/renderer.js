// WebGL renderer: draws every surface (shape) with its effect / image / video /
// text. Shapes are drawn as meshes carrying a uv per vertex, so quads get true
// perspective (finely subdivided) and can have curved edges. Used on the
// projector (full resolution) and on the phone (small live preview).

import { EFFECT_MAP, PRELUDE } from './effects.js';
import { bounds, shapeAspect, shapeMesh, shapeOutline } from './geometry.js';
import { sequenceLevels } from './sequence.js';

const MAXP = 64;

const VS = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_res;
varying vec2 v_uv;
void main(){
  v_uv = a_uv;
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

function fragSource(body) {
  return `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
varying vec2 v_uv;
uniform float u_t;
// Sound (from the phone's microphone): 0..1 levels, beat = flash on each beat.
uniform float u_level; uniform float u_bass; uniform float u_mid; uniform float u_high; uniform float u_beat;
uniform vec3 u_c1; uniform vec3 u_c2; uniform vec3 u_c3;
uniform float u_scale; uniform float u_amount; uniform float u_angle;
uniform float u_aspect; uniform float u_seed;
uniform vec2 u_pts[${MAXP}];
uniform int u_np;
uniform float u_minDim;
uniform float u_mask;
uniform float u_feather;
uniform float u_aa;
uniform float u_opacity;
uniform float u_bright;
uniform sampler2D u_tex;
uniform vec4 u_texXf;
uniform vec4 u_text;
uniform float u_textBg;

vec2 g_px; vec2 g_uv;

float segDist(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
// Normalised distance from the surface edge: 0 at the border, ~0.5 in the middle.
float edge(){
  if (u_mask > 0.5) return max(0.0, 0.5 - length(g_uv - 0.5));
  vec2 first = u_pts[0];
  vec2 prev = first;
  float d = 1e9;
  for (int i = 1; i < ${MAXP}; i++) {
    if (i >= u_np) break;
    vec2 cur = u_pts[i];
    d = min(d, segDist(g_px, prev, cur));
    prev = cur;
  }
  d = min(d, segDist(g_px, prev, first));
  return d / max(u_minDim, 1.0);
}
${PRELUDE}
${body}
void main(){
  vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  g_px = px;
  vec2 uv = v_uv;
  g_uv = uv;
  float a = u_opacity;
  if (u_mask > 0.5) {
    float r = length(uv - 0.5);
    if (r > 0.5) discard;
  }
  // Soft edge (feather) or, when the canvas has no MSAA, a 1px analytic
  // anti-aliased edge - cheaper than multisampling on TV GPUs.
  float soft = max(u_feather, u_aa);
  if (soft > 0.0) a *= smoothstep(0.0, soft, edge());
  vec4 c = shade(uv);
  float alpha = a * c.a;
  gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0) * u_bright * alpha, alpha);
}`;
}

// Offscreen pass for heavy effects: computes fx(uv) once per texel of a small
// texture (uv = texel position), which is then mapped onto the shape. The
// effect's cost then depends on the texture size, not on how big the shape is
// on the wall, and edges stay sharp because masking happens in the full-res pass.
function fboSource(body) {
  return fragSource(`${body}\nvec4 shade(vec2 uv){ return vec4(fx(uv), 1.0); }`)
    .replace(/void main\(\)\{[\s\S]*\}$/, `void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  g_uv = uv; g_px = vec2(0.0);
  gl_FragColor = vec4(clamp(fx(uv), 0.0, 1.0), 1.0);
}`);
}

const TEX_BODY = `
vec4 shade(vec2 uv){
  vec2 t = (uv - 0.5) * u_texXf.xy + 0.5;
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return vec4(0.0);
  vec4 c = texture2D(u_tex, t);
  return vec4(c.rgb * u_c1, c.a);
}`;

// Text: a white-on-transparent strip of the message, tiled for scrolling.
// u_text = (tile width in uv, text height in uv, offset, mode 1=scroll)
const TEXT_BODY = `
vec4 shade(vec2 uv){
  float y = (uv.y - 0.5) / u_text.y + 0.5;
  float x = u_text.w > 0.5 ? fract((uv.x + u_text.z) / u_text.x) : (uv.x - 0.5) / u_text.x + 0.5;
  vec4 t = vec4(0.0);
  if (y >= 0.0 && y <= 1.0 && x >= 0.0 && x <= 1.0) t = texture2D(u_tex, vec2(x, y));
  // Letters are drawn white and take the text colour; emoji keep their colours.
  float colourful = step(0.12, max(t.r, max(t.g, t.b)) - min(t.r, min(t.g, t.b)));
  vec3 ink = mix(u_c1, t.rgb, colourful);
  if (u_textBg > 0.5) return vec4(mix(u_c2, ink, t.a), 1.0);
  return vec4(ink, t.a);
}`;

export const TEXT_FONTS = {
  sans: { name: 'Bold', css: '800 {px}px system-ui, -apple-system, Roboto, "Segoe UI", sans-serif' },
  serif: { name: 'Classic', css: '700 {px}px Georgia, "Times New Roman", serif' },
  mono: { name: 'Digital', css: '700 {px}px "Courier New", monospace' },
  script: { name: 'Script', css: 'italic 700 {px}px "Brush Script MT", "Dancing Script", cursive' },
};

const colorCache = new Map();
export function hexToRGB(hex) {
  let c = colorCache.get(hex);
  if (c) return c;
  let h = String(hex || '#000').replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16) || 0;
  c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  if (colorCache.size > 500) colorCache.clear();
  colorCache.set(hex, c);
  return c;
}

function seedOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{maxDpr?: number, maxWidth?: number, fxScale?: number}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = { maxDpr: 2, maxWidth: 3840, ...opts };
    // Quality knobs (the projector adjusts these automatically):
    //  fxScale  - resolution of heavy effects relative to their on-screen size
    //             (1 = draw directly at full resolution)
    //  resScale - resolution of the whole output (last resort, softens edges)
    this.fxScale = opts.fxScale == null ? 0.5 : opts.fxScale;
    this.resScale = 1;
    this.fbos = new Map();
    this.texts = new Map();
    this.audio = { level: 0, bass: 0, mid: 0, high: 0, beatAge: 9, beats: 0, active: false };
    this.seqTime = 0;
    this.state = null;
    this.times = new Map();
    this.fade = 1;
    this.last = 0;
    this.media = new Map();
    this.onError = null;
    this.frames = 0;
    this._init();
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.gl = null; });
    canvas.addEventListener('webglcontextrestored', () => this._init());
  }

  _init() {
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: this.opts.antialias !== false, premultipliedAlpha: true, preserveDrawingBuffer: false })
      || this.canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL is not available on this device');
    this.gl = gl;
    this.analyticAA = !gl.getContextAttributes().antialias;
    this.programs = new Map();
    this.buf = gl.createBuffer();
    this.ibuf = gl.createBuffer();
    this.quadBuf = gl.createBuffer();
    this.fbos = new Map();
    this.texts = new Map();
    for (const m of this.media.values()) m.tex = null;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  setState(state) { this.state = state; }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  }

  program(key) {
    let p = this.programs.get(key);
    if (p !== undefined) return p;
    const gl = this.gl;
    let src;
    if (key === '__tex') src = fragSource(TEX_BODY);
    else if (key === '__text') src = fragSource(TEXT_BODY);
    else if (key.startsWith('fbo:')) src = fboSource((EFFECT_MAP[key.slice(4)] || EFFECT_MAP.solid).glsl);
    else {
      const fx = EFFECT_MAP[key] || EFFECT_MAP.solid;
      src = fragSource(`${fx.glsl}\nvec4 shade(vec2 uv){ return vec4(fx(uv), 1.0); }`);
    }
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, this._compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, this._compile(gl.FRAGMENT_SHADER, src));
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.bindAttribLocation(prog, 1, 'a_uv');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      const u = {};
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(prog, i);
        const name = info.name.replace(/\[0\]$/, '');
        u[name] = gl.getUniformLocation(prog, info.name);
      }
      p = { prog, u };
    } catch (err) {
      console.error(`Shader "${key}" failed:`, err.message);
      if (this.onError) this.onError(key, err.message);
      p = null;
    }
    this.programs.set(key, p);
    return p;
  }

  /** Pre-compile all shaders (avoids a hitch the first time an effect is picked). */
  warmup() {
    for (const [id, fx] of Object.entries(EFFECT_MAP)) {
      this.program(id);
      if (fx.heavy) this.program('fbo:' + id);
    }
    this.program('__tex');
    this.program('__text');
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxDpr);
    const k = dpr * (this.resScale || 1);
    let w = Math.round(c.clientWidth * k), h = Math.round(c.clientHeight * k);
    if (w > this.opts.maxWidth) { h = Math.round(h * this.opts.maxWidth / w); w = this.opts.maxWidth; }
    w = Math.max(w, 1); h = Math.max(h, 1);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return [w, h];
  }

  // ---- media (images / videos as textures) ----
  _mediaEntry(url, kind) {
    let m = this.media.get(url);
    if (!m) {
      m = { url, kind, tex: null, w: 0, h: 0, ready: false, el: null, lastTime: -1, used: 0 };
      if (kind === 'video') {
        const v = document.createElement('video');
        v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
        v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
        v.crossOrigin = 'anonymous';
        v.src = url;
        v.addEventListener('loadeddata', () => { m.w = v.videoWidth; m.h = v.videoHeight; m.ready = true; });
        const play = () => v.play().catch(() => {});
        v.addEventListener('canplay', play);
        play();
        m.el = v;
      } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { m.w = img.naturalWidth; m.h = img.naturalHeight; m.ready = true; m.dirty = true; };
        img.src = url;
        m.el = img;
      }
      this.media.set(url, m);
    }
    m.used = performance.now();
    return m;
  }

  _textureFor(m) {
    const gl = this.gl;
    if (!m.ready) return null;
    if (!m.tex) {
      m.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, m.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      m.dirty = true;
    }
    gl.bindTexture(gl.TEXTURE_2D, m.tex);
    if (m.kind === 'video') {
      const v = m.el;
      if (v.readyState >= 2 && v.currentTime !== m.lastTime) {
        m.lastTime = v.currentTime;
        m.dirty = true;
      }
      if (v.paused && v.readyState >= 2) v.play().catch(() => {});
    }
    if (m.dirty) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.el);
      } catch (e) { /* not decodable yet */ }
      m.dirty = false;
    }
    return m.tex;
  }

  _gcMedia(now) {
    for (const [url, m] of this.media) {
      if (now - m.used > 5000) {
        if (m.el && m.kind === 'video') { m.el.pause(); m.el.removeAttribute('src'); m.el.load(); }
        if (m.tex && this.gl) this.gl.deleteTexture(m.tex);
        this.media.delete(url);
      }
    }
  }

  // ---- drawing ----
  render(now = performance.now()) {
    const gl = this.gl;
    if (!gl || !this.state) return;
    const [W, H] = this.resize();
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    this.frames++;
    const g = this.state.global || {};
    gl.viewport(0, 0, W, H);
    const bg = g.blackout ? [0, 0, 0] : hexToRGB(g.background || '#000000');
    const master = g.blackout ? 0 : (g.brightness == null ? 1 : g.brightness) * this.fade;
    gl.clearColor(bg[0] * master, bg[1] * master, bg[2] * master, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (master <= 0) return;

    // Sequences light shapes up in turn (or on every beat in "beat" mode).
    const seq = this.state.sequence;
    let levels = null;
    if (seq && seq.enabled) {
      this.seqTime += dt * (seq.speed == null ? 2 : seq.speed);
      const p = seq.mode === 'beat' ? this.audio.beats : this.seqTime;
      levels = sequenceLevels(seq, this.state.shapes, p, this.audio.beatAge);
    }

    for (const shape of this.state.shapes) {
      if (!shape.visible || !shape.points || shape.points.length < 3) continue;
      const c = shape.content || {};
      const react = this._reaction(c);
      const speed = c.speed == null ? 1 : c.speed;
      const t = (this.times.get(shape.id) || 0) + dt * speed * react.speed;
      this.times.set(shape.id, t);
      const k = (levels && levels.has(shape.id) ? levels.get(shape.id) : 1) * react.bright;
      if (k <= 0.001) continue;
      try {
        this._drawShape(shape, c, t, W, H, master * k);
      } catch (err) {
        console.error('draw failed', err);
      }
    }
    if (this.frames % 120 === 0) { this._gcMedia(now); this._gcFbos(now); this._gcTexts(now); }
  }

  /** How a shape reacts to sound: brightness and speed multipliers. */
  _reaction(c) {
    const a = this.audio;
    const amt = c.react || 0;
    if (!amt || !a.active) return { bright: 1, speed: 1 };
    const beat = Math.exp(-a.beatAge * 7);
    switch (c.reactMode) {
      case 'speed': return { bright: 1, speed: 1 + amt * 5 * a.level };
      case 'beat': return { bright: 1 - amt + amt * (0.08 + 0.92 * beat), speed: 1 };
      default: { // pulse with the music's energy (mostly bass)
        const env = Math.min(1, Math.max(a.bass, a.level * 0.85));
        return { bright: 1 - amt + amt * (0.1 + 0.9 * env), speed: 1 };
      }
    }
  }

  _drawShape(shape, c, t, W, H, bright) {
    const gl = this.gl;
    const kind = c.kind || 'effect';
    const isMedia = (kind === 'image' || kind === 'video') && c.media;
    const isText = kind === 'text' && c.text;
    let tex = null, mediaAspect = 1, text = null;
    if (isMedia) {
      const m = this._mediaEntry(c.media, kind);
      tex = this._textureFor(m);
      if (!tex) return; // still loading
      mediaAspect = m.h ? m.w / m.h : 1;
    } else if (isText) {
      text = this._textTexture(c);
      tex = text && text.tex;
      if (!tex) return;
    }
    const mesh = shapeMesh(shape);
    if (!mesh.idx.length) return;
    const pts = shape.points.map(([x, y]) => [x * W, y * H]);
    const outline = shapeOutline(shape).slice(0, MAXP).map(([x, y]) => [x * W, y * H]);
    const bb = bounds(outline);
    const aspect = shapeAspect(shape.type, pts);
    const seed = seedOf(shape.id);
    const fx = EFFECT_MAP[c.effect] || EFFECT_MAP.solid;

    // Heavy effects are computed into a small texture first (see fboSource).
    let offscreen = false;
    if (!isMedia && !isText && fx.heavy && Math.max(this.fxScale, fx.minRes || 0) < 1) {
      tex = this._effectTexture(shape, c, t, fx, pts, bb, aspect, seed);
      offscreen = !!tex;
    }
    const p = this.program(isText ? '__text' : isMedia || offscreen ? '__tex' : fx.id);
    if (!p) return;

    // Interleaved [x, y, u, v] in pixels + an index buffer.
    const nv = mesh.pos.length;
    const verts = new Float32Array(nv * 4);
    for (let i = 0; i < nv; i++) {
      verts[i * 4] = mesh.pos[i][0] * W; verts[i * 4 + 1] = mesh.pos[i][1] * H;
      verts[i * 4 + 2] = mesh.uv[i][0]; verts[i * 4 + 3] = mesh.uv[i][1];
    }
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.idx), gl.DYNAMIC_DRAW);

    const u = p.u;
    const set1 = (name, v) => { if (u[name]) gl.uniform1f(u[name], v); };
    if (u.u_res) gl.uniform2f(u.u_res, W, H);
    this._fxUniforms(u, c, t, aspect, seed);
    if (isMedia) { if (u.u_c1) gl.uniform3fv(u.u_c1, hexToRGB(c.tint || '#ffffff')); }
    else if (offscreen) { if (u.u_c1) gl.uniform3f(u.u_c1, 1, 1, 1); }
    const minDim = Math.max(1, Math.min(bb.w, bb.h));
    set1('u_minDim', minDim);
    set1('u_mask', shape.mask === 'ellipse' ? 1 : 0);
    set1('u_feather', (shape.feather || 0) * 0.5);
    set1('u_aa', this.analyticAA ? 1.2 / minDim : 0);
    set1('u_opacity', shape.opacity == null ? 1 : shape.opacity);
    set1('u_bright', bright);
    if (u.u_np) gl.uniform1i(u.u_np, outline.length);
    if (u.u_pts) {
      const flat = new Float32Array(MAXP * 2);
      for (let i = 0; i < outline.length; i++) { flat[i * 2] = outline[i][0]; flat[i * 2 + 1] = outline[i][1]; }
      gl.uniform2fv(u.u_pts, flat);
    }
    if (isText) {
      // Text height as a fraction of the shape; static text shrinks to fit.
      const ta = text.w / text.h;
      let th = c.size == null ? 0.6 : c.size;
      const scroll = (c.textMode || 'scroll') === 'scroll';
      if (!scroll) th = Math.min(th, (aspect / ta) * 0.94);
      const tile = (ta * th) / aspect;
      if (u.u_text) gl.uniform4f(u.u_text, tile, th, scroll ? t * 0.25 : 0, scroll ? 1 : 0);
      set1('u_textBg', c.textBg === false ? 0 : 1);
    }
    if (tex) {
      let sx = 1, sy = 1;
      const fit = isMedia ? (c.fit || 'stretch') : 'stretch';
      if (fit === 'cover') { if (mediaAspect > aspect) sx = aspect / mediaAspect; else sy = mediaAspect / aspect; }
      else if (fit === 'contain') { if (mediaAspect > aspect) sy = mediaAspect / aspect; else sx = aspect / mediaAspect; }
      if (u.u_texXf) gl.uniform4f(u.u_texXf, sx, sy, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (u.u_tex) gl.uniform1i(u.u_tex, 0);
    }
    gl.drawElements(gl.TRIANGLES, mesh.idx.length, gl.UNSIGNED_SHORT, 0);
  }

  _fxUniforms(u, c, t, aspect, seed) {
    const gl = this.gl;
    const set1 = (name, v) => { if (u[name]) gl.uniform1f(u[name], v); };
    set1('u_t', t);
    if (u.u_c1) gl.uniform3fv(u.u_c1, hexToRGB(c.c1 || '#ffffff'));
    if (u.u_c2) gl.uniform3fv(u.u_c2, hexToRGB(c.c2 || '#000000'));
    if (u.u_c3) gl.uniform3fv(u.u_c3, hexToRGB(c.c3 || '#808080'));
    set1('u_scale', c.scale == null ? 1 : c.scale);
    set1('u_amount', c.amount == null ? 0.5 : c.amount);
    set1('u_angle', ((c.angle || 0) * Math.PI) / 180);
    set1('u_aspect', aspect);
    set1('u_seed', seed);
    const a = this.audio;
    set1('u_level', a.active ? a.level : 0);
    set1('u_bass', a.active ? a.bass : 0);
    set1('u_mid', a.active ? a.mid : 0);
    set1('u_high', a.active ? a.high : 0);
    set1('u_beat', a.active ? Math.exp(-a.beatAge * 7) : 0);
  }

  /** White-on-transparent texture of a text message (cached). */
  _textTexture(c) {
    const font = TEXT_FONTS[c.font] ? c.font : 'sans';
    const scroll = (c.textMode || 'scroll') === 'scroll';
    const key = `${font}|${scroll ? 1 : 0}|${c.text}`;
    let e = this.texts.get(key);
    if (!e) {
      const px = 128;
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d');
      const css = TEXT_FONTS[font].css.replace('{px}', px);
      ctx.font = css;
      const text = String(c.text).slice(0, 200);
      let w = Math.ceil(ctx.measureText(text).width + (scroll ? px * 0.8 : px * 0.15));
      const scale = Math.min(1, 4096 / Math.max(1, w));
      w = Math.max(8, Math.floor(w * scale));
      cv.width = w; cv.height = Math.ceil(px * 1.3 * scale);
      ctx.font = TEXT_FONTS[font].css.replace('{px}', Math.floor(px * scale));
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.textAlign = scroll ? 'left' : 'center';
      ctx.fillText(text, scroll ? 0 : w / 2, cv.height * 0.54);
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      e = { tex, w: cv.width, h: cv.height, used: 0 };
      this.texts.set(key, e);
    }
    e.used = performance.now();
    return e;
  }

  _gcTexts(now) {
    for (const [k, e] of this.texts) {
      if (now - e.used > 5000) { this.gl.deleteTexture(e.tex); this.texts.delete(k); }
    }
  }

  /** Render a heavy effect into a per-shape texture sized to fxScale. */
  _effectTexture(shape, c, t, fx, pts, bb, aspect, seed) {
    const gl = this.gl;
    const p = this.program('fbo:' + fx.id);
    if (!p) return null;
    let sw = bb.w, sh = bb.h;
    if (shape.type === 'quad' && pts.length === 4) {
      const d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
      sw = Math.max(d(pts[0], pts[1]), d(pts[3], pts[2]));
      sh = Math.max(d(pts[0], pts[3]), d(pts[1], pts[2]));
    }
    // Round up to 16px steps so dragging a corner doesn't reallocate every frame.
    const k = Math.max(this.fxScale, fx.minRes || 0);
    const q = (v) => Math.min(1024, Math.max(16, Math.ceil((v * k) / 16) * 16));
    const w = q(sw), h = q(sh);
    let f = this.fbos.get(shape.id);
    if (!f || f.w !== w || f.h !== h) {
      if (f) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); this.fbos.delete(shape.id); return null; }
      f = { fb, tex, w, h, used: 0 };
      this.fbos.set(shape.id, f);
    }
    f.used = performance.now();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, w, 0, 0, h, 0, h, w, 0, w, h]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    if (p.u.u_res) gl.uniform2f(p.u.u_res, w, h);
    this._fxUniforms(p.u, c, t, aspect, seed);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return f.tex;
  }

  _gcFbos(now) {
    for (const [id, f] of this.fbos) {
      if (now - f.used > 3000) {
        this.gl.deleteFramebuffer(f.fb);
        this.gl.deleteTexture(f.tex);
        this.fbos.delete(id);
      }
    }
  }

  /** Render a frame and read back one pixel (0..1 coords). Used by tests. */
  sample(nx, ny) {
    this.render(performance.now());
    const gl = this.gl;
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(nx * this.canvas.width), Math.floor((1 - ny) * this.canvas.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return Array.from(px.slice(0, 3));
  }

  destroy() {
    for (const m of this.media.values()) if (m.kind === 'video' && m.el) { m.el.pause(); m.el.removeAttribute('src'); }
    this.media.clear();
    const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
