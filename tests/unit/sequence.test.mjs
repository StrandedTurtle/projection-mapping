import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sequenceLevel, sequenceLevels, sequenceOrder, SEQ_MODES, defaultSequence } from '../../web/js/engine/sequence.js';

const levels = (mode, n, p, smooth = 0) => Array.from({ length: n }, (_, i) => sequenceLevel(mode, i, n, p, smooth));

test('hard chase lights exactly one shape and wraps around', () => {
  for (let p = 0; p < 10; p += 0.37) {
    const l = levels('chase', 4, p);
    assert.equal(l.filter((v) => v === 1).length, 1, `p=${p}: ${l}`);
    assert.equal(l.indexOf(1), Math.floor(p) % 4);
  }
});

test('build up lights shapes one by one, then switches them off in order', () => {
  const n = 3;
  assert.deepEqual(levels('build', n, 0.99, 0.001).map(Math.round), [1, 0, 0]);
  assert.deepEqual(levels('build', n, 2.99, 0.001).map(Math.round), [1, 1, 1]);
  assert.deepEqual(levels('build', n, 4.99, 0.001).map(Math.round), [0, 0, 1]);
});

test('alternate swaps odd/even; ping-pong turns around at the ends', () => {
  assert.deepEqual(levels('alternate', 4, 0.99, 0.001).map(Math.round), [1, 0, 1, 0]);
  assert.deepEqual(levels('alternate', 4, 1.99, 0.001).map(Math.round), [0, 1, 0, 1]);
  const at = (p) => levels('pingpong', 4, p, 0).indexOf(Math.max(...levels('pingpong', 4, p, 0)));
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(at), [0, 1, 2, 3, 2, 1, 0]);
});

test('every mode stays within 0..1', () => {
  for (const m of SEQ_MODES) {
    for (let p = 0; p < 20; p += 0.13) {
      for (const v of levels(m.id, 5, p, 0.5)) assert.ok(v >= 0 && v <= 1.0001, `${m.id} ${v}`);
    }
  }
});

test('order follows position, and hidden / opted-out shapes are skipped', () => {
  const sq = (id, x, extra = {}) => ({ id, visible: true, points: [[x, 0.4], [x + 0.1, 0.4], [x + 0.1, 0.5], [x, 0.5]], ...extra });
  const shapes = [sq('c', 0.7), sq('a', 0.1), sq('b', 0.4), sq('h', 0.2, { visible: false }), sq('o', 0.3, { inSequence: false })];
  assert.deepEqual(sequenceOrder({ order: 'ltr' }, shapes).map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(sequenceOrder({ order: 'rtl' }, shapes).map((s) => s.id), ['c', 'b', 'a']);
  const lv = sequenceLevels({ ...defaultSequence(), mode: 'chase', smooth: 0, dim: 0.2 }, shapes, 1.5, 1);
  assert.equal(lv.get('b'), 1);
  assert.equal(lv.get('a'), 0.2);
  assert.equal(lv.has('o'), false);
});
