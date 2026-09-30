// The phone's mapping canvas: live preview of the projector output with
// draggable corners, a magnifier while dragging, and shape selection.

import { app } from './app.js';
import { Renderer } from '../engine/renderer.js';
import { pointInPolygon } from '../engine/geometry.js';

const HANDLE_R = 26; // touch radius in CSS px

export function initStage() {
  const stage = document.getElementById('stage');
  const preview = document.getElementById('preview');
  const handles = document.getElementById('handles');
  const loupe = document.getElementById('loupe');
  const hctx = handles.getContext('2d');
  const lctx = loupe.getContext('2d');
  const empty = document.getElementById('stageEmpty');

  let renderer = null;
  try {
    renderer = new Renderer(preview, { maxDpr: 2, maxWidth: 1280 });
    renderer.setState(app.state);
  } catch (e) {
    console.warn('No WebGL preview on this phone:', e);
  }

  const view = { previewOn: true, fine: false };
  let drag = null;
  let pending = null;

  function rect() { return handles.getBoundingClientRect(); }
  function toLocal(e) {
    const r = rect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  }

  function applyAspect() {
    stage.style.aspectRatio = String(app.aspect || 16 / 9);
  }
  app.on((reason) => {
    if (reason === 'status' || reason === 'change') applyAspect();
    empty.hidden = app.state.shapes.length > 0;
  });

  // ---- hit testing ----
  function hitHandle(shape, p) {
    let best = -1, bd = HANDLE_R;
    shape.points.forEach(([x, y], i) => {
      const d = Math.hypot(x * p.w - p.x, y * p.h - p.y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  function hitMidpoint(shape, p) {
    if (shape.type !== 'poly' || shape.points.length >= 64) return -1;
    let best = -1, bd = HANDLE_R * 0.8;
    const n = shape.points.length;
    for (let i = 0; i < n; i++) {
      const a = shape.points[i], b = shape.points[(i + 1) % n];
      const mx = ((a[0] + b[0]) / 2) * p.w, my = ((a[1] + b[1]) / 2) * p.h;
      const d = Math.hypot(mx - p.x, my - p.y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function hitShape(p) {
    const nx = p.x / p.w, ny = p.y / p.h;
    const shapes = app.state.shapes;
    const sel = app.selected();
    if (sel && pointInPolygon(nx, ny, sel.points)) return sel; // prefer the selected one
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.visible && pointInPolygon(nx, ny, s.points)) return s;
    }
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (!s.visible && pointInPolygon(nx, ny, s.points)) return s;
    }
    return null;
  }

  // ---- pointer handling ----
  handles.addEventListener('pointerdown', (e) => {
    if (drag) return; // single finger only
    const p = toLocal(e);
    const sel = app.selected();
    if (sel && !sel.locked) {
      const hi = hitHandle(sel, p);
      if (hi >= 0) {
        startDrag(e, p, sel, 'point', hi);
        app.select(sel.id, hi);
        return;
      }
      const mi = hitMidpoint(sel, p);
      if (mi >= 0) {
        const pts = sel.points.map((q) => q.slice());
        const a = pts[mi], b = pts[(mi + 1) % pts.length];
        pts.splice(mi + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        app.commit({ type: 'updateShape', id: sel.id, patch: { points: pts } });
        app.select(sel.id, mi + 1);
        startDrag(e, p, app.selected(), 'point', mi + 1, true);
        return;
      }
    }
    const hit = hitShape(p);
    if (hit) {
      app.select(hit.id, -1);
      if (!hit.locked) startDrag(e, p, hit, 'shape', -1);
    } else {
      app.select(null);
    }
  });

  function startDrag(e, p, shape, mode, index, alreadySaved = false) {
    handles.setPointerCapture(e.pointerId);
    drag = {
      pointerId: e.pointerId, mode, id: shape.id, index, start: p, last: p,
      orig: shape.points.map((q) => q.slice()), moved: false, saved: alreadySaved,
    };
    app.gesture = true;
  }

  handles.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = toLocal(e);
    drag.last = p;
    const k = view.fine ? 0.25 : 1;
    const dx = ((p.x - drag.start.x) / p.w) * k, dy = ((p.y - drag.start.y) / p.h) * k;
    if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      if (!drag.saved) app.checkpoint();
    }
    let pts;
    if (drag.mode === 'point') {
      pts = drag.orig.map((q) => q.slice());
      pts[drag.index] = [drag.orig[drag.index][0] + dx, drag.orig[drag.index][1] + dy];
    } else {
      pts = drag.orig.map(([x, y]) => [x + dx, y + dy]);
    }
    pending = { id: drag.id, points: pts };
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    flush();
    const moved = drag.moved;
    drag = null;
    app.gesture = false;
    loupe.classList.remove('show');
    if (moved) app.emit('change');
  }
  handles.addEventListener('pointerup', endDrag);
  handles.addEventListener('pointercancel', endDrag);

  function flush() {
    if (!pending) return;
    app.commit({ type: 'updateShape', id: pending.id, patch: { points: pending.points } }, { undo: false, quiet: true });
    pending = null;
  }

  // ---- drawing ----
  function drawHandles() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = rect();
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (handles.width !== W || handles.height !== H) { handles.width = W; handles.height = H; }
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hctx.clearRect(0, 0, r.width, r.height);
    const sel = app.selected();
    for (const s of app.state.shapes) {
      const pts = s.points.map(([x, y]) => [x * r.width, y * r.height]);
      hctx.beginPath();
      pts.forEach((p, i) => (i ? hctx.lineTo(p[0], p[1]) : hctx.moveTo(p[0], p[1])));
      hctx.closePath();
      if (!view.previewOn || !renderer) {
        hctx.fillStyle = hexA(s.content && s.content.kind === 'effect' ? s.content.c1 : '#888888', s.visible ? 0.55 : 0.15);
        hctx.fill();
      }
      const isSel = sel && s.id === sel.id;
      hctx.setLineDash(s.visible && !s.locked ? [] : [5, 4]);
      hctx.lineWidth = isSel ? 2 : 1;
      hctx.strokeStyle = isSel ? '#a78bfa' : 'rgba(255,255,255,.45)';
      hctx.stroke();
      hctx.setLineDash([]);
    }
    if (sel) {
      const pts = sel.points.map(([x, y]) => [x * r.width, y * r.height]);
      if (sel.type === 'poly' && !sel.locked) {
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          hctx.beginPath(); hctx.arc(mx, my, 7, 0, Math.PI * 2);
          hctx.fillStyle = 'rgba(20,20,30,.8)'; hctx.fill();
          hctx.strokeStyle = 'rgba(255,255,255,.7)'; hctx.lineWidth = 1; hctx.stroke();
          hctx.beginPath(); hctx.moveTo(mx - 3.5, my); hctx.lineTo(mx + 3.5, my); hctx.moveTo(mx, my - 3.5); hctx.lineTo(mx, my + 3.5); hctx.stroke();
        }
      }
      if (!sel.locked) {
        pts.forEach(([x, y], i) => {
          const on = i === app.selection.point;
          hctx.beginPath(); hctx.arc(x, y, on ? 11 : 8, 0, Math.PI * 2);
          hctx.fillStyle = on ? '#7c5cff' : '#fff'; hctx.fill();
          hctx.lineWidth = 2; hctx.strokeStyle = on ? '#fff' : '#7c5cff'; hctx.stroke();
          if (on) {
            hctx.beginPath(); hctx.arc(x, y, 3, 0, Math.PI * 2); hctx.fillStyle = '#fff'; hctx.fill();
          }
        });
      }
    }
  }

  function drawLoupe() {
    if (!drag || drag.mode !== 'point' || !drag.moved) { loupe.classList.remove('show'); return; }
    const s = app.selected();
    if (!s || !s.points[drag.index]) return;
    loupe.classList.add('show');
    loupe.classList.toggle('right', drag.last.x < drag.last.w / 2);
    const size = 120, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (loupe.width !== size * dpr) { loupe.width = size * dpr; loupe.height = size * dpr; }
    const [nx, ny] = s.points[drag.index];
    const zoom = 3;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.fillStyle = '#000';
    lctx.fillRect(0, 0, loupe.width, loupe.height);
    for (const src of [renderer ? preview : null, handles]) {
      if (!src || !src.width) continue;
      const sw = (src.width / (drag.last.w * zoom)) * size, sh = (src.height / (drag.last.h * zoom)) * size;
      const sx = nx * src.width - sw / 2, sy = ny * src.height - sh / 2;
      try { lctx.drawImage(src, sx, sy, sw, sh, 0, 0, loupe.width, loupe.height); } catch (e) { /* ignore */ }
    }
    const c = loupe.width / 2;
    lctx.strokeStyle = 'rgba(255,255,255,.9)'; lctx.lineWidth = dpr;
    lctx.beginPath(); lctx.moveTo(c, 0); lctx.lineTo(c, loupe.height); lctx.moveTo(0, c); lctx.lineTo(loupe.width, c); lctx.stroke();
  }

  function render(now) {
    flush();
    if (renderer && view.previewOn) renderer.render(now);
    else if (renderer && !view.cleared) { renderer.gl && renderer.gl.clear(renderer.gl.COLOR_BUFFER_BIT); }
    drawHandles();
    drawLoupe();
  }

  return {
    render,
    setPreview(on) { view.previewOn = on; },
    setFine(on) { view.fine = on; },
    renderer,
  };
}

function hexA(hex, a) {
  let h = String(hex || '#888').replace('#', '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  const n = parseInt(h, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
