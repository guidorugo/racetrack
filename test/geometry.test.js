import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findPolygonDefect,
  orient,
  pointInPolygon,
  pointOnPolygonBoundary,
  pointOnSegment,
  polygonArea2,
  segmentsIntersect,
} from '../src/shared/geometry.js';

const p = (x, y) => ({ x, y });

describe('orient', () => {
  it('distinguishes the two turning directions and collinearity', () => {
    assert.ok(orient(p(0, 0), p(1, 0), p(1, 1)) > 0);
    assert.ok(orient(p(0, 0), p(1, 0), p(1, -1)) < 0);
    assert.equal(orient(p(0, 0), p(1, 1), p(3, 3)), 0);
  });
});

describe('segmentsIntersect', () => {
  const cases = [
    ['proper crossing', [p(0, 0), p(4, 4)], [p(0, 4), p(4, 0)], true],
    ['T junction (endpoint on interior)', [p(0, 0), p(4, 0)], [p(2, 0), p(2, 3)], true],
    ['shared endpoint', [p(0, 0), p(2, 2)], [p(2, 2), p(4, 0)], true],
    ['collinear overlap', [p(0, 0), p(4, 0)], [p(2, 0), p(6, 0)], true],
    ['collinear touching at one point', [p(0, 0), p(2, 0)], [p(2, 0), p(5, 0)], true],
    ['collinear but disjoint', [p(0, 0), p(2, 0)], [p(3, 0), p(5, 0)], false],
    ['parallel', [p(0, 0), p(4, 0)], [p(0, 1), p(4, 1)], false],
    ['would cross if extended', [p(0, 0), p(1, 1)], [p(3, 0), p(2, 1)], false],
    ['far apart', [p(0, 0), p(1, 0)], [p(10, 10), p(11, 12)], false],
    ['degenerate point on segment', [p(2, 2), p(2, 2)], [p(0, 0), p(4, 4)], true],
    ['degenerate point off segment', [p(2, 3), p(2, 3)], [p(0, 0), p(4, 4)], false],
    ['degenerate point at endpoint', [p(4, 4), p(4, 4)], [p(0, 0), p(4, 4)], true],
    ['passes exactly through a vertex', [p(0, 2), p(4, 2)], [p(2, 2), p(2, 5)], true],
  ];
  for (const [name, [a1, a2], [b1, b2], expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      assert.equal(segmentsIntersect(a1, a2, b1, b2), expected);
      // Symmetric in argument order and segment direction.
      assert.equal(segmentsIntersect(b1, b2, a1, a2), expected);
      assert.equal(segmentsIntersect(a2, a1, b2, b1), expected);
    });
  }
});

describe('pointOnSegment', () => {
  it('includes endpoints and interior points, excludes points beyond', () => {
    assert.ok(pointOnSegment(p(0, 0), p(0, 0), p(4, 2)));
    assert.ok(pointOnSegment(p(2, 1), p(0, 0), p(4, 2)));
    assert.ok(!pointOnSegment(p(6, 3), p(0, 0), p(4, 2)));
    assert.ok(!pointOnSegment(p(1, 1), p(0, 0), p(4, 2)));
  });
});

describe('pointInPolygon', () => {
  const square = [p(0, 0), p(10, 0), p(10, 10), p(0, 10)];
  // Concave "C" shape opening to the right.
  const cShape = [p(0, 0), p(10, 0), p(10, 3), p(3, 3), p(3, 7), p(10, 7), p(10, 10), p(0, 10)];

  it('handles convex polygons', () => {
    assert.ok(pointInPolygon(p(5, 5), square));
    assert.ok(!pointInPolygon(p(15, 5), square));
    assert.ok(!pointInPolygon(p(-1, 5), square));
  });

  it('handles concave polygons', () => {
    assert.ok(pointInPolygon(p(1, 5), cShape));
    assert.ok(!pointInPolygon(p(6, 5), cShape)); // inside the notch
    assert.ok(pointInPolygon(p(6, 1), cShape));
  });

  it('is robust when the test ray passes through vertices', () => {
    // Points level with the notch vertices (y = 3 and y = 7).
    assert.ok(pointInPolygon(p(1, 3), cShape));
    assert.ok(pointInPolygon(p(1, 7), cShape));
    assert.ok(!pointInPolygon(p(11, 3), cShape));
    const diamond = [p(5, 0), p(10, 5), p(5, 10), p(0, 5)];
    assert.ok(pointInPolygon(p(4, 5), diamond));
    assert.ok(!pointInPolygon(p(-1, 5), diamond));
    assert.ok(!pointInPolygon(p(11, 5), diamond));
  });

  it('pointOnPolygonBoundary detects edges and vertices', () => {
    assert.ok(pointOnPolygonBoundary(p(5, 0), square));
    assert.ok(pointOnPolygonBoundary(p(10, 10), square));
    assert.ok(!pointOnPolygonBoundary(p(5, 5), square));
  });
});

describe('polygon validation', () => {
  it('accepts simple polygons (both windings) and collinear vertices', () => {
    assert.equal(findPolygonDefect([p(0, 0), p(4, 0), p(4, 4), p(0, 4)]), null);
    assert.equal(findPolygonDefect([p(0, 4), p(4, 4), p(4, 0), p(0, 0)]), null);
    assert.equal(findPolygonDefect([p(0, 0), p(2, 0), p(4, 0), p(4, 4), p(0, 4)]), null);
  });

  it('rejects malformed polygons', () => {
    assert.match(findPolygonDefect([p(0, 0), p(1, 1)]), /at least 3/);
    assert.match(findPolygonDefect([p(0, 0), p(4, 4), p(4, 0), p(0, 4)]), /intersect/); // bow tie
    assert.match(findPolygonDefect([p(0, 0), p(4, 0), p(4, 0), p(0, 4)]), /repeated/);
    assert.match(findPolygonDefect([p(0, 0), p(2, 0), p(4, 0)]), /fold back|zero area/); // degenerate
    assert.match(findPolygonDefect([p(0, 0), p(4, 0), p(2, 0), p(2, 4)]), /fold back|intersect/); // spike
  });

  it('computes signed area', () => {
    assert.equal(Math.abs(polygonArea2([p(0, 0), p(4, 0), p(4, 4), p(0, 4)])), 32);
  });
});
