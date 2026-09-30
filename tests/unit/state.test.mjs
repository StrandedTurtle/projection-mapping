import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultState, createShape, applyOp, captureScene, normalizeState, THEMES, clone,
} from '../../web/js/state.js';
import { EFFECTS, EFFECT_MAP, effectDefaults } from '../../web/js/engine/effects.js';

test('create shapes of every kind', () => {
  const s = defaultState();
  for (const kind of ['rect', 'triangle', 'circle', 'poly']) {
    const sh = createShape(kind, s.shapes);
    applyOp(s, { type: 'addShape', shape: sh });
  }
  assert.equal(s.shapes.length, 4);
  assert.equal(s.shapes[0].type, 'quad');
  assert.equal(s.shapes[1].points.length, 3);
  assert.equal(s.shapes[2].mask, 'ellipse');
  assert.equal(s.shapes[3].points.length, 6);
  for (const sh of s.shapes) for (const [x, y] of sh.points) assert.ok(x > 0 && x < 1 && y > 0 && y < 1);
});

test('ops are deterministic: two replicas stay identical', () => {
  const a = defaultState(), b = defaultState();
  const ops = [];
  const r = createShape('rect', []);
  const t = createShape('triangle', [r]);
  ops.push({ type: 'addShape', shape: r }, { type: 'addShape', shape: t });
  ops.push({ type: 'updateShape', id: r.id, patch: { points: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]], content: { effect: 'fire' } } });
  ops.push({ type: 'reorder', ids: [t.id, r.id] });
  ops.push({ type: 'setGlobal', patch: { brightness: 0.5 } });
  ops.push({ type: 'applyTheme', looks: THEMES[0].looks });
  for (const op of ops) { applyOp(a, clone(op)); applyOp(b, clone(op)); }
  assert.deepEqual(a, b);
  assert.equal(a.shapes[0].id, t.id);
  assert.equal(a.global.brightness, 0.5);
  assert.equal(a.shapes[1].content.effect, THEMES[0].looks[1].effect);
});

test('content patch merges instead of replacing', () => {
  const s = defaultState();
  const r = createShape('rect', []);
  applyOp(s, { type: 'addShape', shape: r });
  applyOp(s, { type: 'updateShape', id: r.id, patch: { content: { speed: 3 } } });
  assert.equal(s.shapes[0].content.speed, 3);
  assert.equal(s.shapes[0].content.kind, 'effect');
});

test('scenes capture and restore looks per shape', () => {
  const s = defaultState();
  const r = createShape('rect', []);
  applyOp(s, { type: 'addShape', shape: r });
  applyOp(s, { type: 'updateShape', id: r.id, patch: { content: { effect: 'plasma' } } });
  const scene = captureScene(s, 'A');
  applyOp(s, { type: 'saveScene', scene });
  applyOp(s, { type: 'updateShape', id: r.id, patch: { content: { effect: 'snow' } } });
  applyOp(s, { type: 'applyScene', id: scene.id });
  assert.equal(s.shapes[0].content.effect, 'plasma');
  applyOp(s, { type: 'setPlaylist', patch: { sceneIds: [scene.id] } });
  applyOp(s, { type: 'removeScene', id: scene.id });
  assert.equal(s.scenes.length, 0);
  assert.deepEqual(s.playlist.sceneIds, []);
});

test('replace + normalize tolerate junk input', () => {
  const s = defaultState();
  applyOp(s, { type: 'replace', state: { shapes: [{ points: [[0, 0]] }, { points: [[0, 0], [1, 0], [1, 1]] }], global: { brightness: 0.3 } } });
  assert.equal(s.shapes.length, 1);
  assert.ok(s.shapes[0].id);
  assert.equal(s.global.brightness, 0.3);
  assert.equal(s.global.showOutlines, true);
  assert.deepEqual(normalizeState(null), defaultState());
});

test('every effect and theme is well formed', () => {
  const ids = new Set();
  for (const fx of EFFECTS) {
    assert.ok(!ids.has(fx.id), 'duplicate ' + fx.id); ids.add(fx.id);
    assert.match(fx.glsl, /vec3 fx\(vec2 uv\)/);
    const d = effectDefaults(fx.id);
    for (const p of fx.params) assert.ok(d[p] !== undefined, `${fx.id}.${p} has no default`);
  }
  for (const t of THEMES) for (const l of t.looks) assert.ok(EFFECT_MAP[l.effect], `${t.id} uses unknown ${l.effect}`);
});
