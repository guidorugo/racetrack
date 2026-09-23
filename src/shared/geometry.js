/**
 * Exact computational-geometry predicates on integer grid coordinates.
 *
 * Every predicate here only multiplies and subtracts integers, so with grid-sized
 * coordinates the results are exact — there is no floating-point tolerance anywhere
 * in collision detection. That is what lets the rules say "touching a wall is a
 * crash" without ambiguity.
 *
 * Functions come in two flavours: object-based (`{x, y}` points) for readability,
 * and `*XY` variants taking plain numbers for the hot loops used by the bot AI.
 *
 * @typedef {import('./vec.js').Vec} Vec
 */

/**
 * Orientation of the triangle (a, b, c): twice its signed area.
 * > 0 and < 0 indicate opposite turning directions, 0 means collinear.
 * @param {number} ax @param {number} ay @param {number} bx @param {number} by
 * @param {number} cx @param {number} cy
 */
export function orientXY(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** @param {Vec} a @param {Vec} b @param {Vec} c */
export function orient(a, b, c) {
  return orientXY(a.x, a.y, b.x, b.y, c.x, c.y);
}

/**
 * Whether point p lies inside the axis-aligned bounding box of segment ab.
 * Combined with collinearity this means "p is on segment ab".
 * @param {number} px @param {number} py @param {number} ax @param {number} ay
 * @param {number} bx @param {number} by
 */
function inBoxXY(px, py, ax, ay, bx, by) {
  return (
    (ax < bx ? ax <= px && px <= bx : bx <= px && px <= ax) &&
    (ay < by ? ay <= py && py <= by : by <= py && py <= ay)
  );
}

/**
 * Whether point p lies on the closed segment ab (endpoints included).
 * @param {Vec} p @param {Vec} a @param {Vec} b
 */
export function pointOnSegment(p, a, b) {
  return orientXY(a.x, a.y, b.x, b.y, p.x, p.y) === 0 && inBoxXY(p.x, p.y, a.x, a.y, b.x, b.y);
}

/**
 * Whether the closed segments p1p2 and q1q2 share at least one point.
 * Touching at an endpoint and collinear overlap both count as intersecting.
 * Degenerate (zero-length) segments are handled and behave like points.
 * @param {number} p1x @param {number} p1y @param {number} p2x @param {number} p2y
 * @param {number} q1x @param {number} q1y @param {number} q2x @param {number} q2y
 */
export function segmentsIntersectXY(p1x, p1y, p2x, p2y, q1x, q1y, q2x, q2y) {
  const d1 = orientXY(q1x, q1y, q2x, q2y, p1x, p1y);
  const d2 = orientXY(q1x, q1y, q2x, q2y, p2x, p2y);
  const d3 = orientXY(p1x, p1y, p2x, p2y, q1x, q1y);
  const d4 = orientXY(p1x, p1y, p2x, p2y, q2x, q2y);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true; // proper crossing
  }
  if (d1 === 0 && inBoxXY(p1x, p1y, q1x, q1y, q2x, q2y)) return true;
  if (d2 === 0 && inBoxXY(p2x, p2y, q1x, q1y, q2x, q2y)) return true;
  if (d3 === 0 && inBoxXY(q1x, q1y, p1x, p1y, p2x, p2y)) return true;
  if (d4 === 0 && inBoxXY(q2x, q2y, p1x, p1y, p2x, p2y)) return true;
  return false;
}

/** @param {Vec} p1 @param {Vec} p2 @param {Vec} q1 @param {Vec} q2 */
export function segmentsIntersect(p1, p2, q1, q2) {
  return segmentsIntersectXY(p1.x, p1.y, p2.x, p2.y, q1.x, q1.y, q2.x, q2.y);
}

/**
 * Even-odd point-in-polygon test (crossing number, ray towards +x).
 * The result is only meaningful for points NOT on the polygon boundary — callers
 * check the boundary separately with {@link pointOnPolygonBoundary}.
 * @param {number} px @param {number} py @param {ReadonlyArray<Vec>} poly
 */
export function pointInPolygonXY(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (a.y > py !== b.y > py) {
      // Sign of (px - x_intersection) scaled by (b.y - a.y); exact in integers.
      const t = (px - a.x) * (b.y - a.y) - (b.x - a.x) * (py - a.y);
      if (b.y > a.y ? t < 0 : t > 0) inside = !inside;
    }
  }
  return inside;
}

/** @param {Vec} p @param {ReadonlyArray<Vec>} poly */
export function pointInPolygon(p, poly) {
  return pointInPolygonXY(p.x, p.y, poly);
}

/** @param {Vec} p @param {ReadonlyArray<Vec>} poly */
export function pointOnPolygonBoundary(p, poly) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (pointOnSegment(p, poly[j], poly[i])) return true;
  }
  return false;
}

/**
 * Twice the signed area of a polygon (shoelace formula). The sign tells the
 * winding direction; the magnitude is used to reject degenerate polygons.
 * @param {ReadonlyArray<Vec>} poly
 */
export function polygonArea2(poly) {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    sum += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return sum;
}

/**
 * Checks that a closed polygon is simple: no zero-length edges, no repeated
 * vertices, and no two edges touching except consecutive edges at their shared vertex.
 * @param {ReadonlyArray<Vec>} poly
 * @returns {string | null} a description of the first problem found, or null if simple
 */
export function findPolygonDefect(poly) {
  const n = poly.length;
  if (n < 3) return 'polygon needs at least 3 vertices';
  const seen = new Set();
  for (const p of poly) {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return `vertex (${k}) is repeated`;
    seen.add(k);
  }
  for (let i = 0; i < n; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const b1 = poly[j];
      const b2 = poly[(j + 1) % n];
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (!segmentsIntersect(a1, a2, b1, b2)) continue;
      if (!adjacent) return `edges ${i} and ${j} intersect`;
      // Adjacent edges share exactly one vertex; anything more is an overlap (a spike).
      const shared = j === i + 1 ? a2 : a1;
      const otherA = j === i + 1 ? a1 : a2;
      const otherB = j === i + 1 ? b2 : b1;
      if (orient(otherA, shared, otherB) === 0) {
        // Collinear consecutive edges are fine only if they continue in the same direction.
        const dx1 = shared.x - otherA.x;
        const dy1 = shared.y - otherA.y;
        const dx2 = otherB.x - shared.x;
        const dy2 = otherB.y - shared.y;
        if (dx1 * dx2 + dy1 * dy2 < 0) return `edges ${i} and ${j} fold back onto each other`;
      }
    }
  }
  if (polygonArea2(poly) === 0) return 'polygon has zero area';
  return null;
}
