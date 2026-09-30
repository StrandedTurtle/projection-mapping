// Shared project state + the operations that change it.
// The projector and every phone hold a copy of the state. Every edit is an
// "op" that is applied locally and broadcast; applyOp is deterministic so all
// copies stay identical.

import { effectDefaults, EFFECT_MAP } from './engine/effects.js';
import { centroid } from './engine/geometry.js';

export const STATE_VERSION = 1;

export function uid(prefix = 's') {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

export function clone(o) { return JSON.parse(JSON.stringify(o)); }

export function defaultGlobal() {
  return {
    brightness: 1,
    blackout: false,
    showOutlines: true,
    testPattern: false,
    showQR: false,
    background: '#000000',
    aspect: 16 / 9,
  };
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    shapes: [],
    scenes: [],
    playlist: { enabled: false, sceneIds: [], interval: 30 },
    global: defaultGlobal(),
  };
}

export function makeContent(effect = 'solid', overrides = {}) {
  return {
    kind: 'effect', // 'effect' | 'image' | 'video'
    effect,
    ...effectDefaults(effect),
    media: '',
    fit: 'stretch', // 'stretch' | 'cover' | 'contain'
    ...overrides,
  };
}

const NAMES = { quad: 'Surface', rect: 'Surface', triangle: 'Triangle', circle: 'Circle', poly: 'Shape' };

/**
 * Build a new shape. kind: rect | triangle | circle | poly
 * Points are normalised 0..1 across the projector output.
 */
export function createShape(kind, existing = [], aspect = 16 / 9) {
  const n = existing.length;
  // Spread new shapes around so they don't all stack on top of each other.
  const offs = [[0, 0], [-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2], [0, -0.25], [0, 0.25]];
  const [ox, oy] = offs[n % offs.length];
  const cx = 0.5 + ox, cy = 0.5 + oy;
  const hh = 0.16, hw = hh / aspect; // square-ish on the wall
  let points, type = 'poly', mask = 'none';
  switch (kind) {
    case 'triangle':
      points = [[cx, cy - hh], [cx + hw * 1.1, cy + hh * 0.8], [cx - hw * 1.1, cy + hh * 0.8]];
      break;
    case 'circle':
      type = 'quad'; mask = 'ellipse';
      points = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
      break;
    case 'poly': {
      points = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
        points.push([cx + Math.cos(a) * hw * 1.1, cy + Math.sin(a) * hh * 1.1]);
      }
      break;
    }
    default:
      type = 'quad';
      points = [[cx - hw * 1.4, cy - hh], [cx + hw * 1.4, cy - hh], [cx + hw * 1.4, cy + hh], [cx - hw * 1.4, cy + hh]];
  }
  const palette = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#af52de', '#ff2d55'];
  const count = existing.filter((s) => s.kind === kind).length + 1;
  return {
    id: uid('s'),
    name: `${NAMES[kind] || 'Shape'} ${count}`,
    kind,
    type,
    points,
    mask,
    visible: true,
    locked: false,
    opacity: 1,
    feather: 0,
    content: makeContent('solid', { c1: palette[n % palette.length] }),
  };
}

export function findShape(state, id) {
  return state.shapes.find((s) => s.id === id);
}

/** Apply an op in place. Returns true if the state changed. */
export function applyOp(state, op) {
  switch (op.type) {
    case 'addShape': {
      if (findShape(state, op.shape.id)) return false;
      const i = op.index == null ? state.shapes.length : op.index;
      state.shapes.splice(i, 0, clone(op.shape));
      return true;
    }
    case 'updateShape': {
      const s = findShape(state, op.id);
      if (!s) return false;
      const { content, ...rest } = op.patch;
      Object.assign(s, clone(rest));
      if (content) s.content = { ...s.content, ...clone(content) };
      return true;
    }
    case 'updateShapes': { // same patch to many shapes (e.g. "apply to all")
      for (const id of op.ids) applyOp(state, { type: 'updateShape', id, patch: op.patch });
      return true;
    }
    case 'removeShape': {
      const i = state.shapes.findIndex((s) => s.id === op.id);
      if (i < 0) return false;
      state.shapes.splice(i, 1);
      return true;
    }
    case 'reorder': {
      const byId = new Map(state.shapes.map((s) => [s.id, s]));
      const next = op.ids.map((id) => byId.get(id)).filter(Boolean);
      for (const s of state.shapes) if (!op.ids.includes(s.id)) next.push(s);
      state.shapes = next;
      return true;
    }
    case 'setGlobal':
      state.global = { ...state.global, ...clone(op.patch) };
      return true;
    case 'saveScene': {
      const i = state.scenes.findIndex((s) => s.id === op.scene.id);
      if (i >= 0) state.scenes[i] = clone(op.scene); else state.scenes.push(clone(op.scene));
      return true;
    }
    case 'removeScene':
      state.scenes = state.scenes.filter((s) => s.id !== op.id);
      state.playlist.sceneIds = state.playlist.sceneIds.filter((id) => id !== op.id);
      return true;
    case 'applyScene': {
      const scene = state.scenes.find((s) => s.id === op.id);
      if (!scene) return false;
      applyLooks(state, scene);
      return true;
    }
    case 'applyTheme':
      applyLooks(state, { looks: op.looks });
      return true;
    case 'setPlaylist':
      state.playlist = { ...state.playlist, ...clone(op.patch) };
      return true;
    case 'replace': {
      const next = normalizeState(op.state);
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, next);
      return true;
    }
    default:
      return false;
  }
}

/**
 * A "look" assigns content to shapes. Saved scenes remember content per shape
 * id (plus a fallback list); themes are just a list cycled across shapes.
 */
function applyLooks(state, scene) {
  const list = scene.looks || [];
  const byId = scene.byId || {};
  state.shapes.forEach((s, i) => {
    const look = byId[s.id] || (list.length ? list[i % list.length] : null);
    if (!look) return;
    const { opacity, feather, mask, ...content } = look;
    s.content = { ...makeContent(content.effect || 'solid'), ...clone(content) };
    if (opacity != null) s.opacity = opacity;
    if (feather != null) s.feather = feather;
  });
}

export function captureScene(state, name) {
  const byId = {};
  for (const s of state.shapes) byId[s.id] = { ...clone(s.content), opacity: s.opacity, feather: s.feather };
  return { id: uid('c'), name, byId, looks: state.shapes.map((s) => byId[s.id]) };
}

export function normalizeState(input) {
  const base = defaultState();
  if (!input || typeof input !== 'object') return base;
  const s = clone(input);
  const out = {
    ...base,
    ...s,
    global: { ...base.global, ...(s.global || {}) },
    playlist: { ...base.playlist, ...(s.playlist || {}) },
    scenes: Array.isArray(s.scenes) ? s.scenes : [],
    shapes: Array.isArray(s.shapes) ? s.shapes : [],
  };
  out.shapes = out.shapes
    .filter((sh) => sh && Array.isArray(sh.points) && sh.points.length >= 3)
    .map((sh) => ({
      visible: true, locked: false, opacity: 1, feather: 0, mask: 'none', type: 'poly', kind: 'poly', name: 'Shape',
      ...sh,
      id: sh.id || uid('s'),
      content: { ...makeContent((sh.content && sh.content.effect) || 'solid'), ...(sh.content || {}) },
    }));
  out.version = STATE_VERSION;
  return out;
}

export function shapeCenter(shape) { return centroid(shape.points); }

// ---------------------------------------------------------------------------
// Built-in themes: one tap re-skins every surface, keeping your mapping.
const L = (effect, o = {}) => ({ ...makeContent(effect), ...o, effect });

export const THEMES = [
  {
    id: 'halloween', name: 'Halloween', emoji: '🎃',
    looks: [
      L('fire'),
      L('eyes'),
      L('plasma', { c1: '#ff6a00', c2: '#6a00ff', c3: '#1a0033', speed: 0.6 }),
      L('lightning'),
      L('pulse', { c1: '#ff6a00', c2: '#2a0040', speed: 0.7 }),
      L('clouds', { c1: '#7cff4f', c2: '#12001f', speed: 0.4 }),
    ],
  },
  {
    id: 'christmas', name: 'Christmas', emoji: '🎄',
    looks: [
      L('stripes', { c1: '#e60000', c2: '#ffffff', speed: 0.5 }),
      L('snow'),
      L('chase', { c1: '#ff1a1a', c2: '#1aff4a', c3: '#000000' }),
      L('sparkle', { c1: '#ffd166', c2: '#062b12' }),
      L('cycle', { c1: '#e60000', c2: '#00a651', c3: '#ffffff', speed: 0.6 }),
    ],
  },
  {
    id: 'party', name: 'Party', emoji: '🪩',
    looks: [
      L('rainbow', { speed: 1.5 }),
      L('cycle', { c1: '#ff00c8', c2: '#00e5ff', c3: '#fff200', speed: 2, amount: 1 }),
      L('spiral', { c1: '#ff00c8', c2: '#1a0033', speed: 1.5 }),
      L('checker', { c1: '#00e5ff', c2: '#ff00c8', speed: 1.5 }),
      L('dots', { c1: '#fff200', c2: '#1a0033', speed: 1.5 }),
    ],
  },
  {
    id: 'chill', name: 'Chill', emoji: '🌊',
    looks: [
      L('water'),
      L('gradient', { c1: '#0f2027', c2: '#2c5364', c3: '#6a82fb', speed: 0.3 }),
      L('lava'),
      L('clouds'),
      L('ripple', { speed: 0.5 }),
    ],
  },
  {
    id: 'fireice', name: 'Fire & Ice', emoji: '🔥',
    looks: [
      L('fire'),
      L('water', { c1: '#001b33', c2: '#bdf4ff' }),
    ],
  },
  {
    id: 'outline', name: 'Architecture', emoji: '🏛️',
    looks: [
      L('glow', { c1: '#ffffff' }),
      L('sweep', { c1: '#ffffff', speed: 0.6 }),
      L('glow', { c1: '#00e5ff' }),
    ],
  },
  {
    id: 'white', name: 'All White', emoji: '💡',
    looks: [L('solid', { c1: '#ffffff' })],
  },
];

export function isKnownEffect(id) { return !!EFFECT_MAP[id]; }
