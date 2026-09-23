/**
 * Track model: the drivable surface, wall collision and finish-line crossing.
 *
 * A track is plain data (see {@link TrackDefinition}) so new tracks can be added
 * by dropping a data file into `tracks/` and registering it — no code changes.
 *
 * Geometry rules (all exact, integer arithmetic):
 *  - `boundaries` are closed polygons. A point is on the track surface when it is
 *    inside an odd number of them (even-odd rule), so an oval is simply
 *    [outerPolygon, innerPolygon].
 *  - Boundary lines are solid walls. A grid point lying exactly on a wall is NOT
 *    on the track, and a move whose straight path touches a wall anywhere
 *    (including grazing a corner) is a crash.
 *  - The finish line is a segment spanning the track from wall to wall, crossing
 *    the drivable surface exactly once. Crossing it along `direction` counts +1
 *    lap, crossing it against `direction` counts -1. Points exactly on the line
 *    count as already past it (half-open rule), so a car parked on the line and
 *    then moving on is never double-counted. Because the line cuts the circuit in
 *    one place, the net count equals the number of laps actually driven.
 *
 * @typedef {import('./vec.js').Vec} Vec
 * @typedef {[number, number]} PointTuple
 *
 * @typedef {Object} TrackDefinition
 * @property {string} id               Stable identifier (lowercase letters, digits, dashes).
 * @property {string} name             Display name.
 * @property {string} [description]
 * @property {number} width            Grid points run from 0 to width (inclusive).
 * @property {number} height           Grid points run from 0 to height (inclusive).
 * @property {PointTuple[][]} boundaries  Closed wall polygons (even-odd rule).
 * @property {{ a: PointTuple, b: PointTuple }} finishLine  Segment from wall to wall.
 * @property {PointTuple} direction    Direction in which the finish line must be crossed.
 * @property {PointTuple[]} startPositions  At least MAX_PLAYERS distinct grid points.
 */

import { MAX_PLAYERS } from './constants.js';
import { distanceAt, getDistanceField } from './distanceField.js';
import { EngineErrors, GameError } from './errors.js';
import {
  findPolygonDefect,
  pointInPolygonXY,
  pointOnSegment,
  segmentsIntersect,
  segmentsIntersectXY,
} from './geometry.js';

const TRACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_GRID_SIZE = 500;

/** @param {unknown} value @returns {value is PointTuple} */
function isPointTuple(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    Number.isSafeInteger(value[1])
  );
}

/** @param {PointTuple} t @returns {Vec} */
function toVec(t) {
  return { x: t[0], y: t[1] };
}

/**
 * Surface test on raw polygons (used during validation, before a Track exists).
 * @param {Vec[][]} polygons @param {Vec} p
 */
function surfaceContains(polygons, p) {
  let count = 0;
  for (const poly of polygons) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (pointOnSegment(p, poly[j], poly[i])) return false;
    }
    if (pointInPolygonXY(p.x, p.y, poly)) count++;
  }
  return count % 2 === 1;
}

/**
 * Validates a track definition and returns a list of human-readable problems
 * (empty when the definition is valid).
 * @param {any} def
 * @returns {string[]}
 */
export function validateTrackDefinition(def) {
  /** @type {string[]} */
  const problems = [];
  if (!def || typeof def !== 'object') return ['track definition must be an object'];

  if (typeof def.id !== 'string' || !TRACK_ID_PATTERN.test(def.id)) {
    problems.push('id must be 1-40 lowercase letters, digits or dashes');
  }
  if (typeof def.name !== 'string' || def.name.trim() === '') problems.push('name is required');
  for (const dim of ['width', 'height']) {
    const v = def[dim];
    if (!Number.isSafeInteger(v) || v < 4 || v > MAX_GRID_SIZE) {
      problems.push(`${dim} must be an integer between 4 and ${MAX_GRID_SIZE}`);
    }
  }
  if (problems.length > 0) return problems;

  /** @param {unknown} p */
  const inBounds = (p) =>
    isPointTuple(p) && p[0] >= 0 && p[1] >= 0 && p[0] <= def.width && p[1] <= def.height;

  // --- Boundaries ------------------------------------------------------------
  if (!Array.isArray(def.boundaries) || def.boundaries.length === 0) {
    return [...problems, 'boundaries must be a non-empty array of polygons'];
  }
  /** @type {Vec[][]} */
  const polygons = [];
  def.boundaries.forEach((/** @type {unknown} */ poly, /** @type {number} */ i) => {
    if (!Array.isArray(poly) || !poly.every(inBounds)) {
      problems.push(`boundary ${i} must be a list of [x, y] integer points inside the grid`);
      return;
    }
    const vertices = poly.map(toVec);
    const defect = findPolygonDefect(vertices);
    if (defect) problems.push(`boundary ${i} is not a simple polygon: ${defect}`);
    else polygons.push(vertices);
  });
  if (problems.length > 0) return problems;

  for (let i = 0; i < polygons.length; i++) {
    for (let j = i + 1; j < polygons.length; j++) {
      if (polygonsTouch(polygons[i], polygons[j])) problems.push(`boundaries ${i} and ${j} touch or cross`);
    }
  }

  // --- Finish line -------------------------------------------------------------
  const fl = def.finishLine;
  if (!fl || !inBounds(fl.a) || !inBounds(fl.b)) {
    problems.push('finishLine must have endpoints a and b inside the grid');
    return problems;
  }
  const a = toVec(fl.a);
  const b = toVec(fl.b);
  if (a.x === b.x && a.y === b.y) problems.push('finishLine endpoints must differ');
  if (surfaceContains(polygons, a) || surfaceContains(polygons, b)) {
    problems.push('finishLine must span the track: both endpoints must lie on or beyond a wall');
  } else {
    const runs = surfaceRunsAlong(polygons, a, b);
    if (runs !== 1) {
      problems.push(`finishLine must cross the track exactly once (it crosses ${runs} stretches of track)`);
    }
  }
  if (!isPointTuple(def.direction)) {
    problems.push('direction must be an [x, y] integer vector');
    return problems;
  }
  const dir = toVec(def.direction);
  const crossDir = (b.x - a.x) * dir.y - (b.y - a.y) * dir.x;
  if (crossDir === 0) problems.push('direction must not be parallel to the finish line');

  // --- Start positions -----------------------------------------------------------
  if (!Array.isArray(def.startPositions) || def.startPositions.length < MAX_PLAYERS) {
    problems.push(`startPositions must list at least ${MAX_PLAYERS} grid points`);
    return problems;
  }
  const seen = new Set();
  const normal = finishNormal(a, b, dir);
  def.startPositions.forEach((/** @type {unknown} */ t, /** @type {number} */ i) => {
    if (!inBounds(t)) {
      problems.push(`startPositions[${i}] must be an [x, y] point inside the grid`);
      return;
    }
    const p = toVec(/** @type {PointTuple} */ (t));
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) problems.push(`startPositions[${i}] duplicates another start position`);
    seen.add(k);
    if (!surfaceContains(polygons, p)) problems.push(`startPositions[${i}] is not on the track surface`);
    // Start positions must not be behind the line, or the first forward step would "finish".
    if ((p.x - a.x) * normal.x + (p.y - a.y) * normal.y < 0) {
      problems.push(`startPositions[${i}] is behind the finish line`);
    }
  });
  return problems;
}

/**
 * Surface test for arbitrary (non-grid) points; points within a hair of a wall
 * count as off the track.
 * @param {Vec[][]} polygons @param {number} x @param {number} y
 */
function surfaceContainsXY(polygons, x, y) {
  let count = 0;
  for (const poly of polygons) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const p = poly[j];
      const q = poly[i];
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      const t = Math.max(0, Math.min(1, ((x - p.x) * ex + (y - p.y) * ey) / (ex * ex + ey * ey)));
      if (Math.hypot(p.x + ex * t - x, p.y + ey * t - y) < 1e-6) return false;
    }
    if (pointInPolygonXY(x, y, poly)) count++;
  }
  return count % 2 === 1;
}

/**
 * How many separate stretches of track surface the segment ab passes over,
 * sampled every 1/50 grid unit (far finer than any drivable gap on a grid track).
 * @param {Vec[][]} polygons @param {Vec} a @param {Vec} b
 */
function surfaceRunsAlong(polygons, a, b) {
  const steps = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 50));
  let runs = 0;
  let inside = false;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const on = surfaceContainsXY(polygons, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    if (on && !inside) runs++;
    inside = on;
  }
  return runs;
}

/** @param {Vec[]} p @param {Vec[]} q */
function polygonsTouch(p, q) {
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    for (let k = 0, l = q.length - 1; k < q.length; l = k++) {
      if (segmentsIntersect(p[j], p[i], q[l], q[k])) return true;
    }
  }
  return false;
}

/**
 * Normal of the finish line pointing in the racing direction.
 * @param {Vec} a @param {Vec} b @param {Vec} dir
 */
function finishNormal(a, b, dir) {
  const n = { x: -(b.y - a.y), y: b.x - a.x };
  return n.x * dir.x + n.y * dir.y >= 0 ? n : { x: -n.x, y: -n.y };
}

export class Track {
  /** @param {TrackDefinition} def */
  constructor(def) {
    const problems = validateTrackDefinition(def);
    if (problems.length > 0) {
      throw new GameError(
        EngineErrors.INVALID_TRACK,
        `Invalid track definition "${def && def.id}": ${problems.join('; ')}`,
        { problems },
      );
    }
    this.id = def.id;
    this.name = def.name;
    this.description = def.description ?? '';
    this.width = def.width;
    this.height = def.height;
    /** @type {ReadonlyArray<ReadonlyArray<Vec>>} */
    this.boundaries = def.boundaries.map((poly) => poly.map(toVec));
    this.finishLine = { a: toVec(def.finishLine.a), b: toVec(def.finishLine.b) };
    this.direction = toVec(def.direction);
    /** Normal of the finish line pointing "ahead" (the way cars must cross it). */
    this.finishNormal = finishNormal(this.finishLine.a, this.finishLine.b, this.direction);
    /** @type {ReadonlyArray<Vec>} */
    this.startPositions = def.startPositions.map(toVec);

    // Flattened wall edges plus bounding boxes for fast collision checks.
    const edgeCount = this.boundaries.reduce((n, poly) => n + poly.length, 0);
    this._edges = new Int32Array(edgeCount * 4);
    this._boxes = new Int32Array(edgeCount * 4);
    let e = 0;
    for (const poly of this.boundaries) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const p = poly[j];
        const q = poly[i];
        this._edges.set([p.x, p.y, q.x, q.y], e);
        this._boxes.set([Math.min(p.x, q.x), Math.max(p.x, q.x), Math.min(p.y, q.y), Math.max(p.y, q.y)], e);
        e += 4;
      }
    }

    // Surface lookup table for every grid point.
    this._stride = this.width + 1;
    this._surface = new Uint8Array((this.width + 1) * (this.height + 1));
    for (let y = 0; y <= this.height; y++) {
      for (let x = 0; x <= this.width; x++) {
        this._surface[y * this._stride + x] = this._computeOnTrack(x, y) ? 1 : 0;
      }
    }

    // Race checks that need the finished track: the finish must be reachable, and
    // every car must start at the beginning of a lap (not halfway round the track
    // on the far side of the line, which the geometric checks can't see).
    const field = getDistanceField(this);
    /** @type {string[]} */
    const raceProblems = [];
    if (field.lapLength === 0) raceProblems.push('the finish line cannot be reached from the track');
    this.startPositions.forEach((p, i) => {
      const d = distanceAt(field, p.x, p.y);
      if (!Number.isFinite(d)) raceProblems.push(`startPositions[${i}] cannot reach the finish line`);
      else if (d < 0.8 * field.lapLength) {
        raceProblems.push(`startPositions[${i}] is not at the start of a lap (only ${Math.round((100 * d) / field.lapLength)}% of a lap from the finish)`);
      }
    });
    if (raceProblems.length > 0) {
      throw new GameError(EngineErrors.INVALID_TRACK, `Invalid track definition "${def.id}": ${raceProblems.join('; ')}`, {
        problems: raceProblems,
      });
    }
    Object.freeze(this);
  }

  /** @param {number} x @param {number} y */
  _computeOnTrack(x, y) {
    const E = this._edges;
    for (let i = 0; i < E.length; i += 4) {
      if (segmentsIntersectXY(x, y, x, y, E[i], E[i + 1], E[i + 2], E[i + 3])) return false;
    }
    let count = 0;
    for (const poly of this.boundaries) if (pointInPolygonXY(x, y, poly)) count++;
    return count % 2 === 1;
  }

  /**
   * Whether the grid point (x, y) is on the drivable surface (strictly inside,
   * not on a wall). Points off the grid are never on the track.
   * @param {number} x @param {number} y
   */
  isOnTrackXY(x, y) {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    if (x < 0 || y < 0 || x > this.width || y > this.height) return false;
    return this._surface[y * this._stride + x] === 1;
  }

  /** @param {Vec} p */
  isOnTrack(p) {
    return this.isOnTrackXY(p.x, p.y);
  }

  /**
   * Whether the straight path from (x0, y0) to (x1, y1) touches any wall.
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   */
  segmentHitsWallXY(x0, y0, x1, y1) {
    const minX = x0 < x1 ? x0 : x1;
    const maxX = x0 < x1 ? x1 : x0;
    const minY = y0 < y1 ? y0 : y1;
    const maxY = y0 < y1 ? y1 : y0;
    const E = this._edges;
    const B = this._boxes;
    for (let i = 0; i < E.length; i += 4) {
      if (B[i + 1] < minX || B[i] > maxX || B[i + 3] < minY || B[i + 2] > maxY) continue;
      if (segmentsIntersectXY(x0, y0, x1, y1, E[i], E[i + 1], E[i + 2], E[i + 3])) return true;
    }
    return false;
  }

  /**
   * A move crashes when its path touches a wall or it ends off the drivable surface.
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   */
  moveHitsWallXY(x0, y0, x1, y1) {
    return !this.isOnTrackXY(x1, y1) || this.segmentHitsWallXY(x0, y0, x1, y1);
  }

  /** @param {Vec} from @param {Vec} to */
  moveHitsWall(from, to) {
    return this.moveHitsWallXY(from.x, from.y, to.x, to.y);
  }

  /**
   * Signed distance-like value of a point relative to the finish line:
   * > 0 ahead of it, < 0 behind it, 0 exactly on its (infinite) line.
   * @param {number} x @param {number} y
   */
  finishSideXY(x, y) {
    const { a } = this.finishLine;
    return (x - a.x) * this.finishNormal.x + (y - a.y) * this.finishNormal.y;
  }

  /**
   * How a straight move changes the lap count:
   * +1 when it crosses the finish line in the racing direction, -1 when it
   * crosses backwards, 0 otherwise. Landing exactly on the line counts as
   * crossing it; leaving the line forwards afterwards does not count again.
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
   * @returns {-1 | 0 | 1}
   */
  finishCrossingXY(x0, y0, x1, y1) {
    const ahead0 = this.finishSideXY(x0, y0) >= 0;
    const ahead1 = this.finishSideXY(x1, y1) >= 0;
    if (ahead0 === ahead1) return 0;
    const { a, b } = this.finishLine;
    if (!segmentsIntersectXY(x0, y0, x1, y1, a.x, a.y, b.x, b.y)) return 0;
    return ahead1 ? 1 : -1;
  }

  /** @param {Vec} from @param {Vec} to */
  finishCrossing(from, to) {
    return this.finishCrossingXY(from.x, from.y, to.x, to.y);
  }
}
