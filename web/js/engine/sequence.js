// Sequences: animate brightness ACROSS shapes - light windows one by one,
// chase around the house, waves, random twinkle, or step on every music beat.

import { centroid } from './geometry.js';

export const SEQ_MODES = [
  { id: 'chase', name: 'Chase', hint: 'one at a time, round and round' },
  { id: 'pingpong', name: 'Ping-pong', hint: 'back and forth' },
  { id: 'wave', name: 'Wave', hint: 'smooth wave of light' },
  { id: 'build', name: 'Build up', hint: 'switch on one by one, then off' },
  { id: 'alternate', name: 'Alternate', hint: 'odd / even swap' },
  { id: 'random', name: 'Twinkle', hint: 'random shapes flash' },
  { id: 'beat', name: 'On the beat', hint: 'steps to the music (sound mode)' },
];

export const SEQ_ORDERS = [
  { id: 'ltr', name: 'Left → right' },
  { id: 'rtl', name: 'Right → left' },
  { id: 'ttb', name: 'Top → bottom' },
  { id: 'btt', name: 'Bottom → top' },
  { id: 'center', name: 'Centre out' },
  { id: 'list', name: 'Layer order' },
];

export function defaultSequence() {
  return { enabled: false, mode: 'chase', order: 'ltr', speed: 2, smooth: 0.4, dim: 0 };
}

function hash(a, b) {
  let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Shapes taking part, in sequence order. */
export function sequenceOrder(seq, shapes) {
  const list = shapes.filter((s) => s.visible && s.inSequence !== false);
  const c = new Map(list.map((s) => [s.id, centroid(s.points)]));
  const key = {
    ltr: (s) => c.get(s.id)[0], rtl: (s) => -c.get(s.id)[0],
    ttb: (s) => c.get(s.id)[1], btt: (s) => -c.get(s.id)[1],
    center: (s) => Math.hypot(c.get(s.id)[0] - 0.5, c.get(s.id)[1] - 0.5),
  }[seq.order];
  return key ? [...list].sort((a, b) => key(a) - key(b)) : list;
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Brightness 0..1 of shape number i (of n) at step position p (p grows by
 * `speed` per second, or by one per beat). smooth 0 = hard switching.
 */
export function sequenceLevel(mode, i, n, p, smooth = 0.4, beatAge = 1) {
  if (n <= 1) return mode === 'random' ? (hash(0, Math.floor(p)) > 0.5 ? 1 : 0.15) : 1;
  const soft = Math.max(0.001, smooth);
  const frac = p - Math.floor(p);
  const fadeIn = smoothstep(0, soft, frac); // eased switch between steps
  switch (mode) {
    case 'pingpong': {
      const period = 2 * (n - 1);
      const q = ((p % period) + period) % period;
      const pos = q <= n - 1 ? q : period - q;
      return Math.max(0, 1 - Math.abs(i - pos) / (0.5 + soft * 1.5));
    }
    case 'wave': {
      const w = 0.5 + 0.5 * Math.cos((2 * Math.PI * (i - p)) / n);
      return Math.pow(w, 1 + (1 - smooth) * 6);
    }
    case 'build': {
      const k = Math.floor(((p % (2 * n)) + 2 * n) % (2 * n));
      if (k < n) return i < k ? 1 : i === k ? fadeIn : 0;
      const off = k - n;
      return i < off ? 0 : i === off ? 1 - fadeIn : 1;
    }
    case 'alternate': {
      const on = (i + Math.floor(p)) % 2 === 0;
      return on ? fadeIn : 1 - fadeIn;
    }
    case 'random': {
      const s = Math.floor(p);
      const now = hash(i, s) > 0.55 ? 1 : 0, before = hash(i, s - 1) > 0.55 ? 1 : 0;
      return before + (now - before) * fadeIn;
    }
    case 'beat': {
      const pos = ((Math.floor(p) % n) + n) % n;
      if (i !== pos) return 0;
      return 1 - smooth * 0.7 * Math.min(1, beatAge * 2); // flash, then settle
    }
    case 'chase':
    default: {
      const pos = ((p % n) + n) % n;
      let d = Math.abs(i - pos);
      d = Math.min(d, n - d); // wraps around
      if (smooth < 0.05) return Math.floor(pos) === i ? 1 : 0;
      return Math.max(0, 1 - d / (0.5 + soft * 2));
    }
  }
}

/** Map shapeId -> brightness multiplier for this frame. */
export function sequenceLevels(seq, shapes, p, beatAge) {
  const order = sequenceOrder(seq, shapes);
  const dim = seq.dim || 0;
  const out = new Map();
  order.forEach((s, i) => {
    const m = sequenceLevel(seq.mode, i, order.length, p, seq.smooth == null ? 0.4 : seq.smooth, beatAge);
    out.set(s.id, dim + (1 - dim) * Math.min(1, Math.max(0, m)));
  });
  return out;
}
