// Geometry helpers shared by the projector renderer and the phone controller.
// All matrices are 3x3, row-major arrays of 9 numbers.

export const EPS = 1e-9;

/**
 * Homography that maps the unit square onto an arbitrary quad.
 * (0,0)->p0, (1,0)->p1, (1,1)->p2, (0,1)->p3  (Heckbert's closed form)
 * Returns null when the quad is degenerate.
 */
export function squareToQuad(p0, p1, p2, p3) {
  const [x0, y0] = p0, [x1, y1] = p1, [x2, y2] = p2, [x3, y3] = p3;
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(dx3) < EPS && Math.abs(dy3) < EPS) {
    a = x1 - x0; b = x2 - x1; c = x0;
    d = y1 - y0; e = y2 - y1; f = y0;
    g = 0; h = 0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2;
    const dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < EPS) return null;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return [a, b, c, d, e, f, g, h, 1];
}

export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < EPS) return null;
  const s = 1 / det;
  return [
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  ];
}

export function applyH(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

export function bounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Matrix mapping a point inside the bounding box to 0..1 uv. */
export function bboxToUV(pts) {
  const bb = bounds(pts);
  const w = Math.max(bb.w, EPS), h = Math.max(bb.h, EPS);
  return [1 / w, 0, -bb.minX / w, 0, 1 / h, -bb.minY / h, 0, 0, 1];
}

/** Is this quad convex (no self intersection, no reflex corner)? */
export function isConvex(pts) {
  const n = pts.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n], [cx, cy] = pts[(i + 2) % n];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < EPS) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return sign !== 0;
}

/**
 * Screen(px) -> uv matrix for a shape. Quads get a true perspective mapping so
 * content looks "painted on" a surface seen at an angle; polygons use their
 * bounding box.
 */
export function uvMatrix(type, pts) {
  if (type === 'quad' && pts.length === 4 && isConvex(pts)) {
    const h = squareToQuad(pts[0], pts[1], pts[2], pts[3]);
    const inv = h && invert3(h);
    if (inv) return inv;
  }
  return bboxToUV(pts);
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pointInTri(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Ear-clipping triangulation. Returns a flat array of vertex indices. */
export function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  if (signedArea(pts) < 0) idx.reverse();
  const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= EPS) continue; // reflex or degenerate corner
      let inside = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTri(pts[j][0], pts[j][1], a, b, c)) { inside = true; break; }
      }
      if (inside) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // self-intersecting: fall back to a fan below
  }
  if (idx.length === 3) { out.push(idx[0], idx[1], idx[2]); return out; }
  // Fallback: triangle fan over whatever is left (handles bow-ties "well enough").
  for (let i = 1; i < idx.length - 1; i++) out.push(idx[0], idx[i], idx[i + 1]);
  return out;
}

export function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + EPS) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

export function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

/** Approximate width/height ratio of a shape, measured in pixels. */
export function shapeAspect(type, pts) {
  if (type === 'quad' && pts.length === 4) {
    const d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const w = (d(pts[0], pts[1]) + d(pts[3], pts[2])) / 2;
    const h = (d(pts[0], pts[3]) + d(pts[1], pts[2])) / 2;
    return h > EPS ? w / h : 1;
  }
  const bb = bounds(pts);
  return bb.h > EPS ? bb.w / bb.h : 1;
}

/** Row-major 3x3 -> column-major Float32Array for gl.uniformMatrix3fv. */
export function toGL(m) {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ---------------------------------------------------------------------------
// Curved edges. A quad may bend each edge: curves[i] = [dx, dy] is how far the
// middle of edge i (p_i -> p_i+1) is pushed out, in the same normalised units
// as the points. Each edge becomes a quadratic Bezier through that point, and
// the inside is blended with a Coons patch on top of the perspective mapping,
// so a straight quad renders exactly as before.

export function hasCurves(shape) {
  return shape.type === 'quad' && shape.points.length === 4 && Array.isArray(shape.curves)
    && shape.curves.some((c) => c && (Math.abs(c[0]) > 1e-6 || Math.abs(c[1]) > 1e-6));
}

/** Point on the (possibly curved, perspective) quad surface at uv. */
export function quadPoint(pts, H, curves, u, v) {
  let x, y;
  if (H) [x, y] = applyH(H, u, v);
  else { // bilinear fallback for degenerate quads
    const [a, b, c, d] = pts;
    x = (1 - u) * (1 - v) * a[0] + u * (1 - v) * b[0] + u * v * c[0] + (1 - u) * v * d[0];
    y = (1 - u) * (1 - v) * a[1] + u * (1 - v) * b[1] + u * v * c[1] + (1 - u) * v * d[1];
  }
  if (curves) {
    // Edge bulge 4s(1-s)*h (h = mid-point offset), blended across the patch.
    const top = 4 * u * (1 - u), side = 4 * v * (1 - v);
    const k = [(1 - v) * top, u * side, v * top, (1 - u) * side];
    for (let i = 0; i < 4; i++) {
      const c = curves[i];
      if (c) { x += k[i] * c[0]; y += k[i] * c[1]; }
    }
  }
  return [x, y];
}

function quadHomography(pts) {
  return isConvex(pts) ? squareToQuad(pts[0], pts[1], pts[2], pts[3]) : null;
}

/** Closed outline polyline of a shape (normalised coords). */
export function shapeOutline(shape, segs = 16) {
  if (!hasCurves(shape)) return shape.points;
  const H = quadHomography(shape.points);
  const out = [];
  const edgeUV = [(s) => [s, 0], (s) => [1, s], (s) => [1 - s, 1], (s) => [0, 1 - s]];
  for (let e = 0; e < 4; e++) {
    for (let i = 0; i < segs; i++) out.push(quadPoint(shape.points, H, shape.curves, ...edgeUV[e](i / segs)));
  }
  return out;
}

const EDGE_MID_UV = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];

/** Where the bend handle of edge i sits (normalised): on the curve itself. */
export function bendHandle(shape, i) {
  const H = quadHomography(shape.points);
  return quadPoint(shape.points, H, hasCurves(shape) ? shape.curves : null, ...EDGE_MID_UV[i]);
}

/** New curves array after dragging the bend handle of edge i to `target`. */
export function bendTo(shape, i, target) {
  const H = quadHomography(shape.points);
  const [x, y] = quadPoint(shape.points, H, null, ...EDGE_MID_UV[i]);
  const curves = (shape.curves || [[0, 0], [0, 0], [0, 0], [0, 0]]).map((c) => (c ? c.slice() : [0, 0]));
  curves[i] = [target[0] - x, target[1] - y];
  return curves;
}

/**
 * Triangle mesh for drawing a shape: pos (normalised xy), uv (0..1) and
 * triangle indices. Quads are subdivided so perspective and curves are smooth;
 * other polygons use their bounding box for uv.
 */
export function shapeMesh(shape, n = 12) {
  const pts = shape.points;
  if (shape.type === 'quad' && pts.length === 4) {
    const H = quadHomography(pts);
    if (H || hasCurves(shape)) {
      const curves = hasCurves(shape) ? shape.curves : null;
      const pos = [], uv = [], idx = [];
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          const u = i / n, v = j / n;
          pos.push(quadPoint(pts, H, curves, u, v));
          uv.push([u, v]);
        }
      }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
          idx.push(a, b, d, a, d, c);
        }
      }
      return { pos, uv, idx };
    }
  }
  const bb = bounds(pts);
  const w = Math.max(bb.w, EPS), h = Math.max(bb.h, EPS);
  return {
    pos: pts,
    uv: pts.map(([x, y]) => [(x - bb.minX) / w, (y - bb.minY) / h]),
    idx: triangulate(pts),
  };
}

/** Bake a curved quad into a free polygon (for "convert to free shape"). */
export function bakeOutline(shape, segs = 6) {
  return hasCurves(shape) ? shapeOutline(shape, segs) : shape.points.map((p) => p.slice());
}

/** Outline to draw for a shape: the ellipse for circle masks, else the edge. */
export function visibleOutline(shape, segs = 48) {
  if (shape.mask === 'ellipse' && shape.type === 'quad' && shape.points.length === 4) {
    const H = quadHomography(shape.points);
    const curves = hasCurves(shape) ? shape.curves : null;
    const out = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      out.push(quadPoint(shape.points, H, curves, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)));
    }
    return out;
  }
  return shapeOutline(shape);
}
