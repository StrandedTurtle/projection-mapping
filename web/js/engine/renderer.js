// WebGL renderer: draws every surface (shape) with its effect / image / video,
// warped with a true perspective homography. Used on the projector (full
// resolution) and on the phone (small live preview).

import { EFFECT_MAP, PRELUDE } from './effects.js';
import { uvMatrix, triangulate, bounds, shapeAspect, toGL } from './geometry.js';

const MAXP = 64;

const VS = `
attribute vec2 a_pos;
uniform vec2 u_res;
void main(){
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
uniform mat3 u_inv;
uniform float u_t;
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
  vec3 h = u_inv * vec3(px, 1.0);
  vec2 uv = h.xy / h.z;
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
    this.quadBuf = gl.createBuffer();
    this.fbos = new Map();
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

    for (const shape of this.state.shapes) {
      if (!shape.visible || !shape.points || shape.points.length < 3) continue;
      const c = shape.content || {};
      const speed = c.speed == null ? 1 : c.speed;
      const t = (this.times.get(shape.id) || 0) + dt * speed;
      this.times.set(shape.id, t);
      try {
        this._drawShape(shape, c, t, W, H, master);
      } catch (err) {
        console.error('draw failed', err);
      }
    }
    if (this.frames % 120 === 0) { this._gcMedia(now); this._gcFbos(now); }
  }

  _drawShape(shape, c, t, W, H, master) {
    const gl = this.gl;
    const isMedia = (c.kind === 'image' || c.kind === 'video') && c.media;
    let tex = null, mediaAspect = 1;
    if (isMedia) {
      const m = this._mediaEntry(c.media, c.kind);
      tex = this._textureFor(m);
      if (!tex) return; // still loading
      mediaAspect = m.h ? m.w / m.h : 1;
    }
    const pts = shape.points.slice(0, MAXP).map(([x, y]) => [x * W, y * H]);
    const idx = triangulate(pts);
    if (!idx.length) return;
    const bb = bounds(pts);
    const aspect = shapeAspect(shape.type, pts);
    const seed = seedOf(shape.id);
    const fx = EFFECT_MAP[c.effect] || EFFECT_MAP.solid;

    // Heavy effects are computed into a small texture first (see fboSource).
    let offscreen = false;
    if (!isMedia && fx.heavy && Math.max(this.fxScale, fx.minRes || 0) < 1) {
      tex = this._effectTexture(shape, c, t, fx, pts, bb, aspect, seed);
      offscreen = !!tex;
    }
    const p = this.program(isMedia || offscreen ? '__tex' : fx.id);
    if (!p) return;

    const verts = new Float32Array(idx.length * 2);
    for (let i = 0; i < idx.length; i++) { verts[i * 2] = pts[idx[i]][0]; verts[i * 2 + 1] = pts[idx[i]][1]; }
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const u = p.u;
    const set1 = (name, v) => { if (u[name]) gl.uniform1f(u[name], v); };
    if (u.u_res) gl.uniform2f(u.u_res, W, H);
    if (u.u_inv) gl.uniformMatrix3fv(u.u_inv, false, toGL(uvMatrix(shape.type, pts)));
    this._fxUniforms(u, c, t, aspect, seed);
    if (isMedia) { if (u.u_c1) gl.uniform3fv(u.u_c1, hexToRGB(c.tint || '#ffffff')); }
    else if (offscreen) { if (u.u_c1) gl.uniform3f(u.u_c1, 1, 1, 1); }
    set1('u_minDim', Math.max(1, Math.min(bb.w, bb.h)));
    set1('u_mask', shape.mask === 'ellipse' ? 1 : 0);
    set1('u_feather', (shape.feather || 0) * 0.5);
    set1('u_aa', this.analyticAA ? 1.2 / Math.max(1, Math.min(bb.w, bb.h)) : 0);
    set1('u_opacity', shape.opacity == null ? 1 : shape.opacity);
    set1('u_bright', master);
    if (u.u_np) gl.uniform1i(u.u_np, pts.length);
    if (u.u_pts) {
      const flat = new Float32Array(MAXP * 2);
      for (let i = 0; i < pts.length; i++) { flat[i * 2] = pts[i][0]; flat[i * 2 + 1] = pts[i][1]; }
      gl.uniform2fv(u.u_pts, flat);
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
    gl.drawArrays(gl.TRIANGLES, 0, idx.length);
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
