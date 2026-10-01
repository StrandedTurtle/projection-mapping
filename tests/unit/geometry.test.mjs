import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  squareToQuad, invert3, applyH, uvMatrix, triangulate, pointInPolygon, isConvex, signedArea, shapeAspect,
} from '../../web/js/engine/geometry.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('square→quad homography maps the 4 corners', () => {
  const q = [[100, 50], [400, 80], [380, 300], [60, 260]];
  const H = squareToQuad(...q);
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  uv.forEach(([u, v], i) => {
    const [x, y] = applyH(H, u, v);
    close(x, q[i][0]); close(y, q[i][1]);
  });
});

test('inverse homography maps quad corners back to uv', () => {
  const q = [[10, 10], [200, 30], [220, 240], [5, 200]];
  const inv = uvMatrix('quad', q);
  const [u, v] = applyH(inv, 220, 240);
  close(u, 1); close(v, 1);
  const [u0, v0] = applyH(inv, 10, 10);
  close(u0, 0); close(v0, 0);
});

test('perspective mapping is projective (centre of quad ≠ average for trapezoid)', () => {
  const q = [[0, 0], [100, 0], [80, 100], [20, 100]];
  const H = squareToQuad(...q);
  const [x, y] = applyH(H, 0.5, 0.5);
  close(x, 50);
  assert.ok(y > 50, 'centre shifts towards the narrower (farther) edge, like real perspective');
});

test('invert3 round trip', () => {
  const m = [2, 1, 3, 0, 1, 4, 5, 6, 0];
  const inv = invert3(m);
  const id = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) id[r * 3 + c] += m[r * 3 + k] * inv[k * 3 + c];
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => close(id[i], v));
});

test('concave quad falls back to bounding-box uv (no crash)', () => {
  const q = [[0, 0], [100, 0], [20, 20], [0, 100]];
  assert.equal(isConvex(q), false);
  const m = uvMatrix('quad', q);
  const [u, v] = applyH(m, 100, 100);
  close(u, 1); close(v, 1);
});

test('triangulate convex and concave polygons', () => {
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(triangulate(square).length, 6);
  const arrow = [[0, 0], [2, 1], [0, 2], [1, 1]]; // concave
  const tris = triangulate(arrow);
  assert.equal(tris.length, 6);
  // total triangle area == polygon area
  let area = 0;
  for (let i = 0; i < tris.length; i += 3) area += Math.abs(signedArea([arrow[tris[i]], arrow[tris[i + 1]], arrow[tris[i + 2]]]));
  close(area, Math.abs(signedArea(arrow)));
  // clockwise order works too
  assert.equal(triangulate([...arrow].reverse()).length, 6);
});

test('point in polygon', () => {
  const tri = [[0, 0], [10, 0], [5, 10]];
  assert.equal(pointInPolygon(5, 3, tri), true);
  assert.equal(pointInPolygon(9, 9, tri), false);
});

test('shape aspect', () => {
  close(shapeAspect('quad', [[0, 0], [200, 0], [200, 100], [0, 100]]), 2);
  close(shapeAspect('poly', [[0, 0], [100, 0], [50, 200]]), 0.5);
});

import { shapeMesh, shapeOutline, bendHandle, bendTo, hasCurves, quadPoint, visibleOutline, bakeOutline } from '../../web/js/engine/geometry.js';

test('straight quad mesh reproduces the perspective mapping exactly at vertices', () => {
  const s = { type: 'quad', points: [[0.1, 0.1], [0.6, 0.15], [0.55, 0.7], [0.12, 0.6]], curves: null };
  const H = squareToQuad(...s.points);
  const m = shapeMesh(s, 8);
  assert.equal(m.pos.length, 81);
  assert.equal(m.idx.length, 8 * 8 * 6);
  m.uv.forEach(([u, v], i) => { const [x, y] = applyH(H, u, v); close(m.pos[i][0], x); close(m.pos[i][1], y); });
  assert.equal(hasCurves(s), false);
  assert.deepEqual(shapeOutline(s), s.points);
});

test('bending an edge moves only that edge, and the handle follows the finger', () => {
  const s = { type: 'quad', points: [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]], curves: null };
  s.curves = bendTo(s, 0, [0.5, 0.05]);
  assert.equal(hasCurves(s), true);
  const [hx, hy] = bendHandle(s, 0);
  close(hx, 0.5); close(hy, 0.05);
  // corners never move
  const H = squareToQuad(...s.points);
  const c = quadPoint(s.points, H, s.curves, 1, 1);
  close(c[0], 0.8); close(c[1], 0.8);
  // the opposite (bottom) edge stays straight
  const b = quadPoint(s.points, H, s.curves, 0.5, 1);
  close(b[1], 0.8);
  const out = shapeOutline(s, 8);
  assert.equal(out.length, 32);
  assert.ok(Math.min(...out.map((p) => p[1])) < 0.06, 'outline bulges up to the handle');
  assert.equal(bakeOutline(s, 6).length, 24);
});

test('ellipse outline is round, not the quad', () => {
  const s = { type: 'quad', mask: 'ellipse', points: [[0, 0], [1, 0], [1, 1], [0, 1]] };
  const o = visibleOutline(s, 40);
  assert.equal(o.length, 40);
  for (const [x, y] of o) close(Math.hypot(x - 0.5, y - 0.5), 0.5, 1e-9);
});
