// Projector output page. Renders the mapped surfaces full screen, shows a QR
// code so a phone can connect, and applies edits streamed from the phone(s).

import { Renderer } from './engine/renderer.js';
import { centroid, shapeOutline, visibleOutline } from './engine/geometry.js';
import { Link } from './net.js';
import { applyOp, normalizeState, defaultState } from './state.js';

const params = new URLSearchParams(location.search);
const glCanvas = document.getElementById('gl');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const connectEl = document.getElementById('connect');
const toastEl = document.getElementById('toast');
const errEl = document.getElementById('err');

let state = defaultState();
let renderer;
try {
  renderer = new Renderer(glCanvas, { maxDpr: 2, maxWidth: parseInt(params.get('maxw') || '1920', 10) });
} catch (e) {
  errEl.textContent = 'This device could not start WebGL: ' + e.message;
}
if (renderer) renderer.onError = (k, m) => { errEl.textContent = `Effect "${k}" failed on this device.`; console.warn(m); };

let selection = { id: null, point: -1 };
let identifyUntil = 0;
let overlayDirty = true;
let controllersEverConnected = false;
let qrManual = null; // null = automatic, true/false = toggled with the remote
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Persistence: the projector is the source of truth. Saved on the server
// (survives app restarts / reinstalls of the web app) and in localStorage.
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}
function save() {
  const json = JSON.stringify(state);
  try { localStorage.setItem('pm-state', json); } catch (e) { /* storage may be unavailable */ }
  fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json }).catch(() => {});
}

async function loadState() {
  let loaded = null;
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (r.ok) loaded = await r.json();
  } catch (e) { /* offline */ }
  if (!loaded) {
    try { loaded = JSON.parse(localStorage.getItem('pm-state') || 'null'); } catch (e) { loaded = null; }
  }
  state = normalizeState(loaded);
  if (renderer) renderer.setState(state);
  overlayDirty = true;
}

// ---------------------------------------------------------------------------
// Connection overlay with QR code.
let controllerUrl = location.origin + '/';
async function setupQR() {
  try {
    const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
    const ip = (info.ips && info.ips[0]) || location.hostname;
    controllerUrl = `http://${ip}:${info.port || location.port || 80}/`;
  } catch (e) { /* keep default */ }
  document.getElementById('url').textContent = controllerUrl.replace(/\/$/, '');
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(controllerUrl);
    qr.make();
    document.getElementById('qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
  } catch (e) {
    document.getElementById('qr').textContent = controllerUrl;
  }
}

function updateConnectOverlay() {
  const hasShapes = state.shapes.length > 0;
  const noPhones = link.peers.controllers === 0;
  let show, big;
  if (qrManual !== null) { show = qrManual; big = true; }
  else if (state.global.showQR) { show = true; big = !hasShapes; }
  else if (!hasShapes) { show = noPhones; big = true; }
  else {
    // A saved show is running: stay out of the way. Only offer a small corner
    // code shortly after start-up, until a phone connects.
    show = noPhones && !controllersEverConnected && Date.now() - startedAt < 90000;
    big = false;
  }
  connectEl.classList.toggle('show', show);
  connectEl.classList.toggle('big', big);
  connectEl.classList.toggle('corner', !big);
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

// ---------------------------------------------------------------------------
// Networking.
function sync() {
  link.send({ t: 'sync', state, aspect: innerWidth / innerHeight });
}

let lastControllers = 0;
// Placeholder until the saved project has loaded (see main()).
let link = { peers: { displays: 0, controllers: 0 }, send() { return false; } };
const linkHandlers = {
  onStatus: (up) => { if (up) sync(); },
  onPeers: (p) => {
    if (p.controllers > lastControllers) {
      controllersEverConnected = true;
      qrManual = null;
      toast(p.controllers > 1 ? `📱 ${p.controllers} phones connected` : '📱 Phone connected');
    }
    if (p.controllers === 0) { selection = { id: null, point: -1 }; overlayDirty = true; }
    lastControllers = p.controllers;
    updateConnectOverlay();
  },
  onMessage: (msg) => {
    switch (msg.t) {
      case 'hello': sync(); break;
      case 'op': handleOp(msg.op, false); break;
      case 'sel':
        selection = { id: msg.id || null, point: msg.point == null ? -1 : msg.point };
        overlayDirty = true;
        break;
      case 'identify': identifyUntil = performance.now() + 4000; overlayDirty = true; break;
      case 'audio': onAudio(msg); break;
      default: break;
    }
  },
};

function handleOp(op, broadcast) {
  if (!op) return;
  const before = JSON.stringify(state.playlist);
  if (applyOp(state, op)) {
    if (op.type === 'replace' && renderer) renderer.setState(state);
    overlayDirty = true;
    scheduleSave();
    updateConnectOverlay();
    if (op.type === 'setGlobal' || op.type === 'replace') { applyQuality(); updateFpsVisibility(); }
    if (JSON.stringify(state.playlist) !== before) restartPlaylist();
  }
  if (broadcast) link.send({ t: 'op', op });
}

// ---------------------------------------------------------------------------
// Scene playlist (runs on the projector so it keeps going with the phone off).
let playlistTimer = null;
let fadeAnim = null;
let playIndex = -1;
function restartPlaylist() {
  clearInterval(playlistTimer);
  playlistTimer = null;
  const pl = state.playlist;
  if (!pl.enabled) return;
  const secs = Math.max(3, pl.interval || 30);
  playlistTimer = setInterval(nextScene, secs * 1000);
}
function nextScene() {
  const ids = state.playlist.sceneIds.filter((id) => state.scenes.some((s) => s.id === id));
  if (!ids.length) return;
  playIndex = (playIndex + 1) % ids.length;
  const id = ids[playIndex];
  fadeAnim = { start: performance.now(), dur: 1200, swapped: false, id };
}
function stepFade(now) {
  if (!fadeAnim || !renderer) return;
  const k = (now - fadeAnim.start) / fadeAnim.dur;
  if (k >= 0.5 && !fadeAnim.swapped) {
    fadeAnim.swapped = true;
    handleOp({ type: 'applyScene', id: fadeAnim.id }, true);
  }
  renderer.fade = k >= 1 ? 1 : Math.abs(1 - 2 * k);
  if (k >= 1) fadeAnim = null;
}

// ---------------------------------------------------------------------------
// Overlay: outlines, selected corner crosshair, test grid, shape names.
const OUTLINE_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#f87171', '#34d399', '#60a5fa'];
function drawOverlay(now) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; overlayDirty = true; }
  const identifying = now < identifyUntil;
  if (!overlayDirty && !identifying && !overlay._wasIdentifying) return;
  overlay._wasIdentifying = identifying;
  overlayDirty = false;
  octx.clearRect(0, 0, W, H);
  const g = state.global;
  // A hidden overlay costs nothing; a visible (even empty) full-screen layer
  // has to be blended every frame, which weak TV GPUs notice.
  const visible = !g.blackout && (g.testPattern || ((g.showOutlines || identifying) && state.shapes.length > 0));
  overlay.style.display = visible ? '' : 'none';
  if (!visible) return;
  const u = Math.max(1, H / 540);

  if (g.testPattern) drawTestPattern(W, H, u);

  if (g.showOutlines || identifying) {
    state.shapes.forEach((s, i) => {
      if (!s.visible && s.id !== selection.id) return;
      const pts = s.points.map(([x, y]) => [x * W, y * H]);
      const outline = shapeOutline(s).map(([x, y]) => [x * W, y * H]);
      const sel = s.id === selection.id;
      const col = OUTLINE_COLORS[i % OUTLINE_COLORS.length];
      octx.save();
      octx.lineJoin = 'round';
      octx.strokeStyle = col;
      octx.lineWidth = sel ? 2.5 * u : 1.2 * u;
      octx.setLineDash(s.visible ? [] : [6 * u, 6 * u]);
      octx.beginPath();
      if (s.mask === 'ellipse' && s.type === 'quad') {
        // show the frame faintly and the ellipse strongly
        octx.globalAlpha = 0.35;
        outline.forEach((p, k) => (k ? octx.lineTo(p[0], p[1]) : octx.moveTo(p[0], p[1])));
        octx.closePath(); octx.stroke(); octx.globalAlpha = 1;
        octx.beginPath();
      }
      visibleOutline(s).forEach(([x, y], k) => (k ? octx.lineTo(x * W, y * H) : octx.moveTo(x * W, y * H)));
      octx.closePath();
      octx.stroke();
      if (sel) {
        pts.forEach((p, k) => {
          octx.beginPath();
          octx.arc(p[0], p[1], (k === selection.point ? 7 : 4.5) * u, 0, Math.PI * 2);
          octx.fillStyle = k === selection.point ? '#fff' : col;
          octx.fill();
        });
      }
      if (identifying || sel) {
        const [cx, cy] = centroid(pts);
        octx.font = `600 ${Math.round(14 * u)}px system-ui, sans-serif`;
        octx.textAlign = 'center'; octx.textBaseline = 'middle';
        octx.lineWidth = 4 * u; octx.strokeStyle = 'rgba(0,0,0,.8)';
        octx.strokeText(s.name, cx, cy);
        octx.fillStyle = '#fff';
        octx.fillText(s.name, cx, cy);
      }
      octx.restore();
    });
    // Crosshair on the corner being adjusted: easy to spot on the real wall.
    const s = state.shapes.find((x) => x.id === selection.id);
    if (s && selection.point >= 0 && s.points[selection.point]) {
      const [x, y] = s.points[selection.point];
      const px = x * W, py = y * H;
      octx.save();
      octx.strokeStyle = 'rgba(255,255,255,.85)';
      octx.lineWidth = 1 * u;
      octx.setLineDash([4 * u, 4 * u]);
      octx.beginPath();
      octx.moveTo(0, py); octx.lineTo(W, py);
      octx.moveTo(px, 0); octx.lineTo(px, H);
      octx.stroke();
      octx.setLineDash([]);
      octx.lineWidth = 2 * u;
      octx.beginPath(); octx.arc(px, py, 14 * u, 0, Math.PI * 2); octx.stroke();
      octx.restore();
    }
  }
}

function drawTestPattern(W, H, u) {
  octx.save();
  octx.strokeStyle = 'rgba(255,255,255,.55)';
  octx.lineWidth = 1 * u;
  const nx = 16, ny = 9;
  octx.beginPath();
  for (let i = 0; i <= nx; i++) { const x = Math.round((i / nx) * (W - 1)) + 0.5; octx.moveTo(x, 0); octx.lineTo(x, H); }
  for (let j = 0; j <= ny; j++) { const y = Math.round((j / ny) * (H - 1)) + 0.5; octx.moveTo(0, y); octx.lineTo(W, y); }
  octx.stroke();
  octx.strokeStyle = '#f43f5e'; octx.lineWidth = 2 * u;
  octx.beginPath();
  octx.moveTo(W / 2, 0); octx.lineTo(W / 2, H); octx.moveTo(0, H / 2); octx.lineTo(W, H / 2);
  octx.stroke();
  octx.beginPath(); octx.arc(W / 2, H / 2, H * 0.3, 0, Math.PI * 2); octx.stroke();
  octx.strokeStyle = '#22d3ee';
  octx.strokeRect(1 * u, 1 * u, W - 2 * u, H - 2 * u);
  octx.restore();
}

// ---------------------------------------------------------------------------
// Main loop.
// ---------------------------------------------------------------------------
// Adaptive quality: keep the projector smooth on modest TV hardware. Heavy
// effects (fire, water, clouds...) are drawn at a reduced internal resolution;
// if frames still drop, the whole output resolution is lowered a little. The
// phone's Projector tab can pin a level instead of "auto".
const LEVELS = [
  { fx: 0.6, res: 1 },     // 0: best (auto starts here)
  { fx: 0.4, res: 1 },
  { fx: 0.3, res: 0.85 },
  { fx: 0.25, res: 0.7 },
  { fx: 0.2, res: 0.55 },  // 4: lowest
];
const FIXED = { high: { fx: 1, res: 1 }, balanced: LEVELS[1], performance: LEVELS[3] };
const perf = {
  level: 0, intervals: [], last: 0, vsync: Infinity, bad: 0, good: 0,
  holdUntil: 0, failedAt: new Array(LEVELS.length).fill(-Infinity), fps: 0,
};
const fpsEl = document.getElementById('fps');

function applyQuality() {
  if (!renderer) return;
  const mode = state.global.quality || 'auto';
  const q = FIXED[mode] || LEVELS[perf.level];
  renderer.fxScale = q.fx;
  renderer.resScale = q.res;
}

function trackPerformance(now) {
  if (perf.last) {
    const dt = now - perf.last;
    if (dt < 1500) { perf.intervals.push(dt); if (perf.intervals.length > 120) perf.intervals.shift(); }
    else perf.intervals.length = 0; // tab hidden / app paused: start over
  }
  perf.last = now;
  // Decide once per second, using at least ~1s of frames (works at 60fps and at 3fps).
  let span = 0;
  for (const d of perf.intervals) span += d;
  if (perf.intervals.length < 5 || span < 900 || now < perf.holdUntil || now - (perf.checked || 0) < 1000) return;
  perf.checked = now;
  const sorted = [...perf.intervals].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  // The display's real refresh interval, learned from the fastest frames seen
  // (some TV interfaces run at 50Hz or even 30Hz - that is not "slow").
  perf.vsync = Math.min(perf.vsync, Math.max(8, sorted[Math.floor(sorted.length * 0.1)]));
  perf.fps = Math.round(1000 / median);
  if (fpsEl.style.display !== 'none') {
    const mode = state.global.quality || 'auto';
    fpsEl.textContent = `${perf.fps} fps · ${mode === 'auto' ? 'auto ' + (perf.level + 1) + '/' + LEVELS.length : mode}`;
  }
  if ((state.global.quality || 'auto') !== 'auto') return;
  if (median > perf.vsync * 1.3) { perf.bad += median > perf.vsync * 2 ? 2 : 1; perf.good = 0; }
  else if (median < perf.vsync * 1.1) { perf.good++; perf.bad = 0; }
  else { perf.bad = 0; perf.good = 0; }
  if (perf.bad >= 2 && perf.level < LEVELS.length - 1) {
    perf.failedAt[perf.level] = now;
    perf.level++;
    perf.bad = 0; perf.intervals.length = 0; perf.holdUntil = now + 500;
    applyQuality();
  } else if (perf.good >= 10 && perf.level > 0 && now - perf.failedAt[perf.level - 1] > 60000) {
    perf.level--;
    perf.good = 0; perf.intervals.length = 0; perf.holdUntil = now + 500;
    applyQuality();
  }
}

// ---------------------------------------------------------------------------
// Sound from the phone's microphone. Levels rise instantly and fall smoothly;
// if the phone stops sending (screen off, mic off) everything returns to normal.
const sound = { target: { l: 0, b: 0, m: 0, h: 0 }, lastMsg: 0, lastBeat: -1, last: 0 };
function onAudio(msg) {
  sound.target = { l: +msg.l || 0, b: +msg.b || 0, m: +msg.m || 0, h: +msg.h || 0 };
  sound.lastMsg = performance.now();
  if (renderer && typeof msg.beat === 'number' && msg.beat !== sound.lastBeat) {
    if (sound.lastBeat >= 0) { renderer.audio.beats++; renderer.audio.beatAge = 0; }
    sound.lastBeat = msg.beat;
  }
}
function stepAudio(now) {
  if (!renderer) return;
  const a = renderer.audio;
  const dt = sound.last ? Math.min(0.1, (now - sound.last) / 1000) : 0;
  sound.last = now;
  a.active = now - sound.lastMsg < 1500;
  a.beatAge += dt;
  const t = a.active ? sound.target : { l: 0, b: 0, m: 0, h: 0 };
  const follow = (cur, tgt) => (tgt > cur ? tgt : cur + (tgt - cur) * Math.min(1, dt * 8));
  a.level = follow(a.level, t.l); a.bass = follow(a.bass, t.b); a.mid = follow(a.mid, t.m); a.high = follow(a.high, t.h);
}

function frame(now) {
  trackPerformance(now);
  stepAudio(now);
  stepFade(now);
  if (renderer) renderer.render(now);
  drawOverlay(now);
  requestAnimationFrame(frame);
}

// TV remote / keyboard: OK toggles the QR code, F toggles fullscreen.
addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 23 || e.key === 'q') {
    const visible = connectEl.classList.contains('show');
    qrManual = !visible;
    updateConnectOverlay();
    e.preventDefault();
  } else if (e.key === 'f') {
    toggleFullscreen();
  }
});
function updateFpsVisibility() {
  fpsEl.style.display = state.global.showFps ? '' : 'none';
}
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}
addEventListener('dblclick', toggleFullscreen);
addEventListener('resize', () => { overlayDirty = true; sync(); });

let cursorTimer;
addEventListener('mousemove', () => {
  document.body.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 2000);
});

async function keepAwake() {
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) { /* not supported */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

(async function main() {
  document.body.classList.add('hide-cursor');
  await Promise.all([loadState(), setupQR()]);
  if (renderer) { renderer.setState(state); renderer.warmup(); }
  applyQuality();
  updateFpsVisibility();
  link = new Link('display', linkHandlers);
  updateConnectOverlay();
  setInterval(updateConnectOverlay, 5000);
  restartPlaylist();
  keepAwake();
  sync();
  requestAnimationFrame(frame);
  window.__pm = { get state() { return state; }, get renderer() { return renderer; }, get link() { return link; }, perf };
})();
