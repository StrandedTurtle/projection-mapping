// Controller panels: Shapes, Look, Scenes, Projector settings + context bar.

import { app } from './app.js';
import {
  createShape, makeContent, captureScene, clone, uid, THEMES, defaultState, normalizeState,
} from '../state.js';
import { EFFECTS, EFFECT_MAP, PARAMS, effectDefaults, paramLabel } from '../engine/effects.js';
import { Renderer, TEXT_FONTS } from '../engine/renderer.js';
import { SEQ_MODES, SEQ_ORDERS } from '../engine/sequence.js';
import { centroid, hasCurves, bendHandle, bendTo, bakeOutline } from '../engine/geometry.js';

const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

const ICONS = {
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>',
};

const SWATCHES = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#ffd6a5'];

let toastTimer;
export function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function describe(shape) {
  const c = shape.content || {};
  if ((c.kind === 'image' || c.kind === 'video') && c.media) return c.kind === 'video' ? 'Video' : 'Image';
  if (c.kind === 'text' && c.text) return `Text: “${c.text.slice(0, 24)}${c.text.length > 24 ? '…' : ''}”`;
  return (EFFECT_MAP[c.effect] || EFFECT_MAP.solid).name;
}
function swatchColor(shape) {
  const c = shape.content || {};
  return c.kind === 'effect' || !c.media ? (c.c1 || '#888') : '#64748b';
}

// Toggle the "on" class for a segmented control.
function segSet(el, attr, value) {
  for (const b of el.querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === String(value));
}

// ============================================================================
export function initPanels(stage) {
  let tab = 'shapes';
  let lookTarget = 'one';
  let tagFilter = 'all';
  let step = 5;
  let mediaList = [];

  // ---------------- tabs ----------------
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    for (const x of $('tabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
    for (const name of ['shapes', 'look', 'scenes', 'setup']) $(`panel-${name}`).hidden = name !== tab;
    if (tab === 'look') { refreshMedia(); requestAnimationFrame(layoutFxGrid); }
    refresh();
  });

  // ---------------- header ----------------
  $('undoBtn').onclick = () => app.undo();
  $('redoBtn').onclick = () => app.redo();
  $('outlineBtn').onclick = () => setGlobal({ showOutlines: !app.state.global.showOutlines });
  $('blackoutBtn').onclick = () => setGlobal({ blackout: !app.state.global.blackout });

  function setGlobal(patch, opts = {}) {
    app.commit({ type: 'setGlobal', patch }, { key: 'global:' + Object.keys(patch).join(), ...opts });
  }

  // ---------------- shapes panel ----------------
  for (const b of document.querySelectorAll('[data-add]')) {
    b.addEventListener('click', () => {
      const shape = createShape(b.dataset.add, app.state.shapes, app.aspect);
      app.commit({ type: 'addShape', shape });
      app.select(shape.id, -1);
      if (!app.state.global.showOutlines) setGlobal({ showOutlines: true }, { undo: false });
    });
  }

  function renderShapeList() {
    const ul = $('shapeList');
    ul.textContent = '';
    const shapes = app.state.shapes;
    const sel = app.selection.id;
    // Front-most first, like layers in a drawing app.
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      const li = h('li', { class: `${s.id === sel ? 'sel' : ''} ${s.visible ? '' : 'hidden-shape'}`, 'data-id': s.id },
        h('span', { class: 'swatch', style: `background:${swatchColor(s)}` }),
        h('div', { class: 'nm' }, h('b', {}, s.name), h('small', {}, describe(s) + (s.locked ? ' · locked' : ''))),
        h('button', { class: `mini ${s.visible ? '' : 'off'}`, title: 'Show / hide', html: s.visible ? ICONS.eye : ICONS.eyeOff,
          onclick: (e) => { e.stopPropagation(); app.commit({ type: 'updateShape', id: s.id, patch: { visible: !s.visible } }); } }),
        h('button', { class: `mini ${s.locked ? 'on' : ''}`, title: 'Lock', html: s.locked ? ICONS.lock : ICONS.unlock,
          onclick: (e) => { e.stopPropagation(); app.commit({ type: 'updateShape', id: s.id, patch: { locked: !s.locked } }); } }),
        h('button', { class: 'mini', title: 'Bring forward', html: ICONS.up, disabled: i === shapes.length - 1,
          onclick: (e) => { e.stopPropagation(); move(s.id, +1); } }),
        h('button', { class: 'mini', title: 'Send backward', html: ICONS.down, disabled: i === 0,
          onclick: (e) => { e.stopPropagation(); move(s.id, -1); } }),
      );
      li.addEventListener('click', () => app.select(s.id === app.selection.id ? null : s.id, -1));
      ul.appendChild(li);
    }
    $('shapeActions').hidden = !app.selected();
    const s = app.selected();
    if (s) $('convertBtn').textContent = s.type === 'quad' ? 'To free shape' : (s.points.length === 4 ? 'To perspective' : 'Free shape');
    $('convertBtn').disabled = !!s && s.type !== 'quad' && s.points.length !== 4;
  }

  function move(id, dir) {
    const ids = app.state.shapes.map((s) => s.id);
    const i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    app.commit({ type: 'reorder', ids });
  }

  $('renameBtn').onclick = () => {
    const s = app.selected(); if (!s) return;
    const name = prompt('Name this shape', s.name);
    if (name && name.trim()) app.commit({ type: 'updateShape', id: s.id, patch: { name: name.trim().slice(0, 40) } });
  };
  $('dupBtn').onclick = () => {
    const s = app.selected(); if (!s) return;
    const copy = clone(s);
    copy.id = uid('s');
    copy.name = s.name.replace(/( copy)*$/, '') + ' copy';
    copy.points = copy.points.map(([x, y]) => [x + 0.03, y + 0.03]);
    copy.locked = false;
    const index = app.state.shapes.findIndex((x) => x.id === s.id) + 1;
    app.commit({ type: 'addShape', shape: copy, index });
    app.select(copy.id, -1);
  };
  $('convertBtn').onclick = () => {
    const s = app.selected(); if (!s) return;
    if (s.type === 'quad') {
      app.commit({ type: 'updateShape', id: s.id, patch: { type: 'poly', kind: 'poly', mask: 'none', points: bakeOutline(s), curves: null } });
      toast('Now a free shape: tap ＋ between corners to add more');
    } else if (s.points.length === 4) {
      app.commit({ type: 'updateShape', id: s.id, patch: { type: 'quad', kind: 'rect' } });
      toast('Perspective mode: content follows the 4 corners');
    }
  };
  $('deleteBtn').onclick = () => {
    const s = app.selected(); if (!s) return;
    app.commit({ type: 'removeShape', id: s.id });
    app.select(null);
    toast('Deleted — tap Undo to bring it back');
  };

  // ---------------- context bar (nudge / transform) ----------------
  $('deselectBtn').onclick = () => app.select(null);
  $('stepSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    step = +b.dataset.step; segSet($('stepSeg'), 'step', step);
  });
  $('fineToggle').addEventListener('change', (e) => stage.setFine(e.target.checked));
  $('cyclePointBtn').onclick = () => {
    const s = app.selected(); if (!s) return;
    const n = s.points.length;
    const next = app.selection.point + 1;
    app.select(s.id, next >= n ? -1 : next);
  };

  function nudge(dx, dy) {
    const s = app.selected();
    if (!s) return;
    if (s.locked) { toast('This shape is locked'); return; }
    const ddx = (dx * step) / 1920, ddy = (dy * step) / 1080;
    const pi = app.selection.point;
    const points = s.points.map(([x, y], i) => (pi < 0 || i === pi ? [x + ddx, y + ddy] : [x, y]));
    app.commit({ type: 'updateShape', id: s.id, patch: { points } }, { key: 'nudge:' + s.id, quiet: true });
  }
  for (const b of document.querySelectorAll('.nb[data-dx]')) {
    let t1, t2;
    const stop = () => { clearTimeout(t1); clearInterval(t2); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      nudge(+b.dataset.dx, +b.dataset.dy);
      t1 = setTimeout(() => { t2 = setInterval(() => nudge(+b.dataset.dx, +b.dataset.dy), 70); }, 380);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function transform(fn) {
    const s = app.selected(); if (!s) return;
    if (s.locked) { toast('This shape is locked'); return; }
    const a = app.aspect;
    const pts = s.points.map(([x, y]) => [x * a, y]);
    const [cx, cy] = centroid(pts);
    const map = ([x, y]) => { const [X, Y] = fn(x * a - cx, y - cy); return [(X + cx) / a, Y + cy]; };
    const patch = { points: s.points.map(map) };
    if (hasCurves(s)) {
      // Move the bend handles with the shape so curves rotate/scale/mirror too.
      let next = { ...s, points: patch.points, curves: null };
      for (let i = 0; i < 4; i++) next = { ...next, curves: bendTo(next, i, map(bendHandle(s, i))) };
      patch.curves = next.curves;
    }
    app.commit({ type: 'updateShape', id: s.id, patch }, { key: 'xf:' + s.id, quiet: true });
  }
  const rot = (deg) => (x, y) => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    return [x * c - y * sn, x * sn + y * c];
  };
  const TOOLS = {
    grow: () => transform((x, y) => [x * 1.04, y * 1.04]),
    shrink: () => transform((x, y) => [x / 1.04, y / 1.04]),
    rotL: () => transform(rot(-2)),
    rotR: () => transform(rot(2)),
    flipH: () => transform((x, y) => [-x, y]),
    flipV: () => transform((x, y) => [x, -y]),
    bend: () => {
      stage.setBend(!stage.bend);
      $('bendBtn').classList.toggle('on', stage.bend);
      if (stage.bend) toast('Drag the blue diamonds to curve each edge');
    },
    straighten: () => {
      const s = app.selected(); if (!s || s.locked) return;
      app.commit({ type: 'updateShape', id: s.id, patch: { curves: null } });
    },
    addPoint: () => {
      const s = app.selected(); if (!s || s.locked) return;
      const pts = s.points.map((p) => p.slice());
      const i = app.selection.point >= 0 ? app.selection.point : pts.length - 1;
      const a = pts[i], b = pts[(i + 1) % pts.length];
      pts.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      const patch = { points: pts };
      if (s.type === 'quad') Object.assign(patch, { type: 'poly', kind: 'poly', mask: 'none', curves: null });
      app.commit({ type: 'updateShape', id: s.id, patch });
      app.select(s.id, i + 1);
    },
    delPoint: () => {
      const s = app.selected(); if (!s || s.locked) return;
      if (s.points.length <= 3) { toast('A shape needs at least 3 corners'); return; }
      const i = app.selection.point >= 0 ? app.selection.point : s.points.length - 1;
      const pts = s.points.filter((_, k) => k !== i);
      const patch = { points: pts };
      if (s.type === 'quad') Object.assign(patch, { type: 'poly', kind: 'poly', mask: 'none', curves: null });
      app.commit({ type: 'updateShape', id: s.id, patch });
      app.select(s.id, Math.min(i, pts.length - 1));
    },
  };
  for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => TOOLS[b.dataset.tool]());

  function renderContext() {
    const s = app.selected();
    $('context').hidden = !s;
    if (!s) return;
    $('ctxName').textContent = s.name;
    $('ctxSwatch').style.background = swatchColor(s);
    const pi = app.selection.point;
    $('ctxSub').textContent = s.locked ? 'locked' : pi >= 0 ? `corner ${pi + 1} of ${s.points.length}` : 'whole shape';
    $('pointTools').hidden = s.mask === 'ellipse' || s.locked;
    $('bendTools').hidden = s.type !== 'quad' || s.mask === 'ellipse' || s.locked;
    $('bendBtn').classList.toggle('on', stage.bend);
  }

  // ---------------- look panel ----------------
  $('targetSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    lookTarget = b.dataset.target; refresh();
  });

  function targetIds() {
    if (lookTarget === 'all') return app.state.shapes.map((s) => s.id);
    return app.selection.id ? [app.selection.id] : [];
  }
  function lookSource() {
    return app.selected() || (lookTarget === 'all' ? app.state.shapes[0] : null);
  }
  function setContent(patch, opts = {}) {
    const ids = targetIds();
    if (!ids.length) return;
    app.commit({ type: 'updateShapes', ids, patch: { content: patch } }, opts);
  }
  function setSurface(patch, opts = {}) {
    const ids = targetIds();
    if (!ids.length) return;
    app.commit({ type: 'updateShapes', ids, patch }, opts);
  }

  $('kindSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const patch = { kind: b.dataset.kind };
    const src = lookSource();
    if (b.dataset.kind === 'text' && src && !src.content.text) Object.assign(patch, { text: 'Happy Halloween!', c1: '#ffffff', c2: '#000000' });
    setContent(patch);
  });

  // ---- text ----
  function renderText(c) {
    const box = $('textSection');
    box.textContent = '';
    const ta = h('textarea', { rows: '2', maxlength: '200', placeholder: 'Type your message…' });
    ta.value = c.text || '';
    ta.addEventListener('input', () => setContent({ text: ta.value }, { key: 'text', quiet: true }));
    const fonts = h('div', { class: 'seg wide' }, ...Object.entries(TEXT_FONTS).map(([id, f]) => h('button', {
      class: (c.font || 'sans') === id ? 'on' : '', onclick: () => setContent({ font: id }),
    }, f.name)));
    const mode = h('div', { class: 'seg' }, ...[['scroll', 'Scrolling'], ['static', 'Still']].map(([id, label]) => h('button', {
      class: (c.textMode || 'scroll') === id ? 'on' : '', onclick: () => setContent({ textMode: id }),
    }, label)));
    const bg = h('input', { type: 'checkbox', class: 'switch' });
    bg.checked = c.textBg !== false;
    bg.addEventListener('change', () => setContent({ textBg: bg.checked }));
    box.append(
      ta, fonts,
      h('div', { class: 'field' }, h('span', {}, 'Motion'), mode),
      rangeField('Text size', c.size == null ? 0.6 : c.size, { min: 0.15, max: 1, step: 0.01 }, (v) => setContent({ size: v }, { key: 'tsize', quiet: true }), '%'),
      rangeField('Scroll speed', c.speed == null ? 1 : c.speed, { min: 0, max: 4, step: 0.05 }, (v) => setContent({ speed: v }, { key: 'tspeed', quiet: true })),
      colorField('Text colour', c.c1 || '#ffffff', (v, live) => setContent({ c1: v }, { key: 'c:c1', quiet: live })),
      h('label', { class: 'switch-row' }, h('span', {}, 'Background box'), bg),
    );
    if (c.textBg !== false) box.append(colorField('Box colour', c.c2 || '#000000', (v, live) => setContent({ c2: v }, { key: 'c:c2', quiet: live })));
  }

  // Tag filter chips.
  const TAGS = [['all', 'All'], ['halloween', 'Halloween'], ['christmas', 'Christmas'], ['party', 'Party'], ['trippy', 'Trippy'],
    ['architecture', 'Building'], ['calm', 'Calm'], ['nature', 'Nature'], ['sound', '🎤 Sound'], ['basic', 'Basic']];
  $('tagChips').append(...TAGS.map(([id, label]) => h('button', {
    class: 'chip', 'data-tag': id,
    onclick: () => { tagFilter = id; renderFxGrid(); },
  }, label)));

  // Animated effect picker: one WebGL canvas behind a grid of buttons.
  let fxRenderer = null;
  const fxState = { shapes: [], scenes: [], playlist: {}, global: { brightness: 1, background: '#000000' } };
  try {
    fxRenderer = new Renderer($('fxCanvas'), { maxDpr: 1.5, maxWidth: 900 });
    fxRenderer.setState(fxState);
  } catch (e) { /* no preview; names still work */ }

  function visibleEffects() {
    return EFFECTS.filter((fx) => tagFilter === 'all' || (fx.tags || []).includes(tagFilter));
  }
  function renderFxGrid() {
    for (const c of $('tagChips').children) c.classList.toggle('on', c.dataset.tag === tagFilter);
    const grid = $('fxGrid');
    grid.textContent = '';
    const src = lookSource();
    const cur = src && src.content && src.content.kind === 'effect' ? src.content.effect : null;
    for (const fx of visibleEffects()) {
      grid.appendChild(h('button', {
        class: fx.id === cur ? 'on' : '', 'data-fx': fx.id,
        onclick: () => setContent({ kind: 'effect', effect: fx.id, ...effectDefaults(fx.id) }),
      }, h('span', {}, fx.name)));
    }
    requestAnimationFrame(layoutFxGrid);
  }
  function layoutFxGrid() {
    const grid = $('fxGrid');
    const W = grid.clientWidth, H = grid.clientHeight;
    if (!W || !H) return;
    fxState.shapes = [...grid.children].map((b) => {
      const x0 = b.offsetLeft / W, y0 = b.offsetTop / H, x1 = (b.offsetLeft + b.offsetWidth) / W, y1 = (b.offsetTop + b.offsetHeight) / H;
      const id = b.dataset.fx;
      return {
        id: 'fx-' + id, type: 'quad', visible: true, opacity: 1, feather: 0, mask: 'none',
        points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        content: makeContent(id),
      };
    });
  }
  addEventListener('resize', () => requestAnimationFrame(layoutFxGrid));

  function renderParams() {
    const box = $('params');
    box.textContent = '';
    const src = lookSource();
    if (!src) return;
    const c = src.content;
    const fx = EFFECT_MAP[c.effect] || EFFECT_MAP.solid;
    for (const p of fx.params) {
      const def = PARAMS[p];
      const label = paramLabel(fx.id, p);
      if (def.type === 'color') box.appendChild(colorField(label, c[p] || '#ffffff', (v, live) => setContent({ [p]: v }, { key: 'c:' + p, quiet: live })));
      else box.appendChild(rangeField(label, c[p], def, (v) => setContent({ [p]: v }, { key: 'r:' + p, quiet: true })));
    }
  }

  function colorField(label, value, onChange) {
    const input = h('input', { type: 'color', value });
    input.addEventListener('input', () => onChange(input.value, true));
    input.addEventListener('change', () => onChange(input.value, false));
    const sw = SWATCHES.map((col) => h('button', {
      class: 'sw', style: `background:${col}`, title: col,
      onclick: () => { input.value = col; onChange(col, false); },
    }));
    return h('div', { class: 'field' }, h('span', {}, label), h('div', { class: 'colors' }, input, ...sw));
  }
  function rangeField(label, value, def, onChange, fmt) {
    const v = value == null ? def.min : value;
    const out = h('output', {}, fmtNum(v, fmt));
    const input = h('input', { type: 'range', min: def.min, max: def.max, step: def.step, value: v });
    input.addEventListener('input', () => { out.textContent = fmtNum(+input.value, fmt); onChange(+input.value); });
    return h('div', { class: 'field' }, h('span', {}, label), input, out);
  }
  function fmtNum(v, fmt) {
    if (fmt === '%') return Math.round(v * 100) + '%';
    if (fmt === 's') return v >= 60 ? `${Math.floor(v / 60)}m${v % 60 ? (v % 60) + 's' : ''}` : `${v}s`;
    return Math.abs(v) >= 10 ? String(Math.round(v)) : (+v).toFixed(2).replace(/\.?0+$/, '') || '0';
  }

  function renderSurface() {
    const box = $('surfaceParams');
    box.textContent = '';
    const src = lookSource();
    if (!src) return;
    box.appendChild(rangeField('Opacity', src.opacity == null ? 1 : src.opacity, { min: 0, max: 1, step: 0.01 },
      (v) => setSurface({ opacity: v }, { key: 'opacity', quiet: true }), '%'));
    box.appendChild(rangeField('Soft edge', src.feather || 0, { min: 0, max: 1, step: 0.01 },
      (v) => setSurface({ feather: v }, { key: 'feather', quiet: true }), '%'));
    box.appendChild(rangeField('React to sound', src.content.react || 0, { min: 0, max: 1, step: 0.01 },
      (v) => setContent({ react: v }, { key: 'react', quiet: true }), '%'));
    box.appendChild(h('div', { class: 'field' }, h('span', {}, 'Reaction'), h('div', { class: 'seg' },
      ...[['pulse', 'Pulse'], ['beat', 'Beat flash'], ['speed', 'Speed']].map(([id, label]) => h('button', {
        class: (src.content.reactMode || 'pulse') === id ? 'on' : '', onclick: () => setContent({ reactMode: id }),
      }, label)))));
    if (app.state.sequence && app.state.sequence.enabled) {
      const sq = h('input', { type: 'checkbox', class: 'switch' });
      sq.checked = src.inSequence !== false;
      sq.addEventListener('change', () => setSurface({ inSequence: sq.checked }));
      box.appendChild(h('label', { class: 'switch-row' }, h('span', {}, 'In sequence'), sq));
    }
    if (src.type === 'quad') {
      const cb = h('input', { type: 'checkbox', class: 'switch' });
      cb.checked = src.mask === 'ellipse';
      cb.addEventListener('change', () => setSurface({ mask: cb.checked ? 'ellipse' : 'none' }));
      box.appendChild(h('label', { class: 'switch-row' }, h('span', {}, 'Round (ellipse) mask'), cb));
    }
  }

  $('copyAllBtn').onclick = () => {
    const src = lookSource(); if (!src) return;
    app.commit({
      type: 'updateShapes', ids: app.state.shapes.map((s) => s.id),
      patch: { content: clone(src.content), opacity: src.opacity, feather: src.feather },
    });
    toast('Look copied to all shapes');
  };

  // ---- media ----
  async function refreshMedia() {
    try {
      const r = await fetch('/api/media', { cache: 'no-store' });
      mediaList = r.ok ? await r.json() : [];
    } catch (e) { mediaList = []; }
    renderMedia();
  }
  function renderMedia() {
    const grid = $('mediaGrid');
    grid.textContent = '';
    const src = lookSource();
    const kind = src ? src.content.kind : 'image';
    const items = mediaList.filter((m) => m.kind === kind);
    if (!items.length) {
      grid.appendChild(h('div', { class: 'media-empty' }, kind === 'video' ? 'No videos yet — upload one from your phone.' : 'No images yet — upload one from your phone.'));
    }
    for (const m of items) {
      const on = src && src.content.media === m.url;
      const thumb = m.kind === 'video'
        ? h('video', { src: m.url + '#t=0.5', muted: true, playsinline: true, preload: 'metadata' })
        : h('img', { src: m.url, loading: 'lazy', alt: '' });
      grid.appendChild(h('div', {
        class: `media-item ${on ? 'on' : ''}`, role: 'button', tabindex: '0',
        onclick: () => setContent({ kind: m.kind, media: m.url }),
      }, thumb, h('span', {}, m.name), h('button', {
        class: 'del', title: 'Delete file',
        onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete ${m.name} from the projector?`)) return;
          await fetch('/api/media/' + encodeURIComponent(m.url.split('/').pop()), { method: 'DELETE' });
          refreshMedia();
        },
      }, '✕')));
    }
  }

  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const res = await uploadMedia(file);
      const kind = file.type.startsWith('video') ? 'video' : 'image';
      await refreshMedia();
      if (targetIds().length) setContent({ kind, media: res.url });
      toast('Uploaded ✓');
    } catch (err) {
      toast('Upload failed: ' + err.message);
    }
  });
  $('fitSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setContent({ fit: b.dataset.fit });
  });
  $('tintInput').addEventListener('input', (e) => setContent({ tint: e.target.value }, { key: 'tint', quiet: true }));

  function renderLook() {
    const src = lookSource();
    const noTarget = !targetIds().length;
    $('lookEmpty').hidden = !noTarget;
    $('lookBody').hidden = noTarget;
    $('targetOne').textContent = app.selected() ? app.selected().name : 'Selected';
    segSet($('targetSeg'), 'target', lookTarget);
    if (noTarget || !src) return;
    const c = src.content;
    const kind = c.kind || 'effect';
    segSet($('kindSeg'), 'kind', kind);
    $('effectSection').hidden = kind !== 'effect';
    $('mediaSection').hidden = kind !== 'image' && kind !== 'video';
    $('textSection').hidden = kind !== 'text';
    $('uploadLabel').textContent = kind === 'video' ? '⬆ Upload a video from your phone' : '⬆ Upload a photo from your phone';
    $('fileInput').accept = kind === 'video' ? 'video/*' : 'image/*';
    if (kind === 'text') renderText(c);
    else if (kind === 'effect') { renderFxGrid(); renderParams(); } else { renderMedia(); segSet($('fitSeg'), 'fit', c.fit || 'stretch'); $('tintInput').value = c.tint || '#ffffff'; }
    renderSurface();
  }

  // ---------------- scenes panel ----------------
  $('themeGrid').append(...THEMES.map((t) => h('button', {
    onclick: () => {
      if (!app.state.shapes.length) { toast('Add some shapes first'); return; }
      app.commit({ type: 'applyTheme', looks: t.looks });
      toast(`${t.emoji} ${t.name} applied`);
    },
  }, h('b', {}, t.emoji), t.name)));

  $('saveSceneBtn').onclick = () => {
    if (!app.state.shapes.length) { toast('Add some shapes first'); return; }
    const name = prompt('Scene name', `Scene ${app.state.scenes.length + 1}`);
    if (!name || !name.trim()) return;
    const scene = captureScene(app.state, name.trim().slice(0, 40));
    app.commit({ type: 'saveScene', scene });
    app.commit({ type: 'setPlaylist', patch: { sceneIds: [...app.state.playlist.sceneIds, scene.id] } }, { undo: false });
    toast('Scene saved');
  };

  function renderScenes() {
    const ul = $('sceneList');
    ul.textContent = '';
    const pl = app.state.playlist;
    if (!app.state.scenes.length) ul.appendChild(h('li', { class: 'scene-empty' }, 'Save a few looks, then tap one to switch instantly or tick them for the slideshow.'));
    for (const sc of app.state.scenes) {
      const cb = h('input', { type: 'checkbox', class: 'pl', title: 'Include in slideshow' });
      cb.checked = pl.sceneIds.includes(sc.id);
      cb.addEventListener('change', () => {
        const ids = pl.sceneIds.filter((id) => id !== sc.id);
        if (cb.checked) ids.push(sc.id);
        app.commit({ type: 'setPlaylist', patch: { sceneIds: ids } });
      });
      ul.appendChild(h('li', {}, cb,
        h('div', { class: 'nm' }, h('b', {}, sc.name), h('small', {}, `${Object.keys(sc.byId || {}).length} shapes`)),
        h('button', { class: 'mini', title: 'Show now', html: ICONS.play, onclick: () => { app.commit({ type: 'applyScene', id: sc.id }); toast(`${sc.name} ▶`); } }),
        h('button', { class: 'mini', title: 'Delete scene', html: ICONS.trash, onclick: () => { if (confirm(`Delete scene “${sc.name}”?`)) app.commit({ type: 'removeScene', id: sc.id }); } }),
      ));
    }
    renderSequence();
    $('playToggle').checked = !!pl.enabled;
    $('playInterval').value = pl.interval || 30;
    $('playIntervalOut').textContent = fmtNum(pl.interval || 30, 's');
  }
  // ---- sequence ----
  const setSeq = (patch, opts = {}) => app.commit({ type: 'setSequence', patch }, { key: 'seq:' + Object.keys(patch).join(), ...opts });
  $('seqModes').append(...SEQ_MODES.map((m) => h('button', { class: 'chip', 'data-mode': m.id, onclick: () => setSeq({ mode: m.id, enabled: true }) }, m.name)));
  $('seqOrder').append(...SEQ_ORDERS.map((o) => h('option', { value: o.id }, o.name)));
  $('seqOrder').addEventListener('change', (e) => setSeq({ order: e.target.value }));
  $('seqToggle').addEventListener('change', (e) => {
    if (e.target.checked && app.state.shapes.length < 2) toast('Tip: sequences need at least 2 shapes');
    setSeq({ enabled: e.target.checked });
  });
  for (const [id, key, fmt] of [['seqSpeed', 'speed', ''], ['seqSmooth', 'smooth', '%'], ['seqDim', 'dim', '%']]) {
    $(id).addEventListener('input', (e) => {
      $(id + 'Out').textContent = fmtNum(+e.target.value, fmt);
      setSeq({ [key]: +e.target.value }, { quiet: true });
    });
  }
  function renderSequence() {
    const q = app.state.sequence || {};
    $('seqToggle').checked = !!q.enabled;
    $('seqBody').hidden = !q.enabled;
    for (const c of $('seqModes').children) c.classList.toggle('on', c.dataset.mode === q.mode);
    $('seqOrder').value = q.order || 'ltr';
    $('seqSpeed').value = q.speed == null ? 2 : q.speed; $('seqSpeedOut').textContent = fmtNum(+$('seqSpeed').value);
    $('seqSmooth').value = q.smooth == null ? 0.4 : q.smooth; $('seqSmoothOut').textContent = fmtNum(+$('seqSmooth').value, '%');
    $('seqDim').value = q.dim || 0; $('seqDimOut').textContent = fmtNum(+$('seqDim').value, '%');
    const mode = SEQ_MODES.find((m) => m.id === q.mode);
    const n = app.state.shapes.filter((s) => s.visible && s.inSequence !== false).length;
    $('seqHint').textContent = `${mode ? mode.hint + '. ' : ''}${n} shape${n === 1 ? '' : 's'} taking part — untick "In sequence" on a shape's Look tab to keep it always on.`
      + (q.mode === 'beat' ? ' Turn on the microphone (🎤 at the top) so it can hear the beat.' : '');
  }

  $('playToggle').addEventListener('change', (e) => {
    if (e.target.checked && !app.state.playlist.sceneIds.length) toast('Tick at least one saved scene');
    app.commit({ type: 'setPlaylist', patch: { enabled: e.target.checked } });
  });
  $('playInterval').addEventListener('input', (e) => {
    $('playIntervalOut').textContent = fmtNum(+e.target.value, 's');
    app.commit({ type: 'setPlaylist', patch: { interval: +e.target.value } }, { key: 'interval', quiet: true });
  });

  // ---------------- projector (setup) panel ----------------
  $('brightness').addEventListener('input', (e) => {
    $('brightnessOut').textContent = Math.round(e.target.value * 100) + '%';
    setGlobal({ brightness: +e.target.value }, { quiet: true });
  });
  const bindSwitch = (id, key) => $(id).addEventListener('change', (e) => setGlobal({ [key]: e.target.checked }));
  bindSwitch('blackoutToggle', 'blackout');
  bindSwitch('outlineToggle', 'showOutlines');
  bindSwitch('gridToggle', 'testPattern');
  bindSwitch('qrToggle', 'showQR');
  bindSwitch('fpsToggle', 'showFps');
  $('qualitySeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    setGlobal({ quality: b.dataset.q });
  });
  let previewOn = true;
  try { previewOn = localStorage.getItem('pm-preview') !== '0'; } catch (e) { /* ignore */ }
  stage.setPreview(previewOn);
  $('previewToggle').checked = previewOn;
  $('previewToggle').addEventListener('change', (e) => {
    stage.setPreview(e.target.checked);
    try { localStorage.setItem('pm-preview', e.target.checked ? '1' : '0'); } catch (err) { /* ignore */ }
  });
  $('bgInput').addEventListener('input', (e) => setGlobal({ background: e.target.value }, { quiet: true }));
  $('identifyBtn').onclick = () => app.link.send({ t: 'identify' });

  $('exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(app.state, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `projection-mapping-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('importInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const state = normalizeState(JSON.parse(await f.text()));
      app.commit({ type: 'replace', state });
      app.select(null);
      toast('Project imported');
    } catch (err) { toast('That file could not be read'); }
  });
  $('resetBtn').onclick = () => {
    if (!confirm('Remove all shapes and scenes? (You can still Undo.)')) return;
    app.commit({ type: 'replace', state: defaultState() });
    app.select(null);
  };

  function renderSetup() {
    const g = app.state.global;
    $('brightness').value = g.brightness;
    $('brightnessOut').textContent = Math.round(g.brightness * 100) + '%';
    $('blackoutToggle').checked = !!g.blackout;
    $('outlineToggle').checked = !!g.showOutlines;
    $('gridToggle').checked = !!g.testPattern;
    $('qrToggle').checked = !!g.showQR;
    $('bgInput').value = g.background || '#000000';
    segSet($('qualitySeg'), 'q', g.quality || 'auto');
    $('fpsToggle').checked = !!g.showFps;
  }

  // ---------------- header state / status ----------------
  function renderHeader() {
    const g = app.state.global;
    $('outlineBtn').classList.toggle('on', !!g.showOutlines);
    $('blackoutBtn').classList.toggle('on', !!g.blackout);
    $('undoBtn').disabled = !app.canUndo();
    $('redoBtn').disabled = !app.canRedo();
  }
  function renderStatus() {
    const link = app.link;
    const el = $('status'), txt = $('statusText'), banner = $('banner');
    el.classList.remove('ok', 'bad');
    if (!link || !link.connected) {
      txt.textContent = 'Connecting…';
      el.classList.add('bad');
      banner.hidden = false;
      banner.textContent = 'Can’t reach the projector. Make sure the Projection Mapper app is open on the TV and your phone is on the same Wi‑Fi.';
    } else if (link.peers.displays === 0) {
      txt.textContent = 'Projector app closed';
      banner.hidden = false;
      banner.textContent = 'Connected, but the projector screen isn’t open. Open Projection Mapper on the TV (or /display.html on the computer driving the projector).';
    } else {
      txt.textContent = link.peers.controllers > 1 ? `Projector ✓ · ${link.peers.controllers} phones` : 'Projector connected';
      el.classList.add('ok');
      banner.hidden = true;
    }
  }

  // ---------------- refresh orchestration ----------------
  let queued = false;
  function refresh() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderHeader();
      renderContext();
      if (tab === 'shapes') renderShapeList();
      if (tab === 'look') renderLook();
      if (tab === 'scenes') renderScenes();
      if (tab === 'setup') renderSetup();
    });
  }
  app.on((reason) => {
    if (reason === 'status') { renderStatus(); refresh(); return; }
    if (reason === 'quiet') { renderContext(); renderHeader(); return; }
    refresh();
  });

  renderStatus();
  refresh();

  let lastFx = 0;
  return {
    /** Called every animation frame by main.js */
    frame(now) {
      if (tab === 'look' && fxRenderer && !$('effectSection').hidden && !$('lookBody').hidden && now - lastFx > 33) {
        lastFx = now;
        if (!fxState.shapes.length) layoutFxGrid();
        fxRenderer.render(now);
      }
    },
  };
}

// Upload with progress; big photos are downscaled on the phone first.
async function uploadMedia(file) {
  let body = file, name = file.name || 'upload';
  if (file.type.startsWith('image/') && !/gif$/i.test(file.type)) {
    try {
      const shrunk = await downscale(file, 2048);
      if (shrunk) { body = shrunk.blob; name = name.replace(/\.[^.]+$/, '') + shrunk.ext; }
    } catch (e) { /* upload original */ }
  }
  if (!/\.[a-z0-9]+$/i.test(name)) name += file.type.startsWith('video') ? '.mp4' : '.jpg';
  const bar = document.getElementById('uploadProgress');
  bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  try {
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media?name=' + encodeURIComponent(name));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`; };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else { let m = 'error ' + xhr.status; try { m = JSON.parse(xhr.responseText).error || m; } catch (e) { /* */ } reject(new Error(m)); }
      };
      xhr.onerror = () => reject(new Error('network error'));
      xhr.send(body);
    });
  } finally {
    setTimeout(() => { bar.hidden = true; }, 600);
  }
}

function downscale(file, max) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { naturalWidth: w, naturalHeight: hgt } = img;
      const k = Math.min(1, max / Math.max(w, hgt));
      const png = /png|webp/i.test(file.type);
      if (k === 1 && /jpe?g|png/i.test(file.type)) { resolve(null); return; }
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(hgt * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((blob) => (blob ? resolve({ blob, ext: png ? '.png' : '.jpg' }) : reject(new Error('encode'))), png ? 'image/png' : 'image/jpeg', 0.9);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
