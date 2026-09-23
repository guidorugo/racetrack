/**
 * "Distance to go" for every grid point of a track.
 *
 * `dist[p]` is the length of the shortest 8-connected path (orthogonal steps cost 1,
 * diagonal steps √2) from grid point p to a forward crossing of the finish line,
 * travelling only over the track surface, never touching a wall and never crossing
 * the finish line on the way. A point just past the line is therefore about one
 * full lap away, and a point just before it is one step away.
 *
 * Used by the bot AI (to measure progress) and by the race standings shown in the UI.
 *
 * @typedef {import('./track.js').Track} Track
 *
 * @typedef {Object} DistanceField
 * @property {number} width
 * @property {number} height
 * @property {number} stride        width + 1
 * @property {Float64Array} dist    Infinity for points off the track or unreachable.
 * @property {number} lapLength     Distance of the farthest reachable point (≈ one lap).
 */

const S = Math.SQRT2;
/** [dx, dy, cost] */
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, S], [1, -1, S], [-1, 1, S], [-1, -1, S],
];

/** @type {WeakMap<Track, DistanceField>} */
const cache = new WeakMap();

/**
 * Memoised per track instance.
 * @param {Track} track
 * @returns {DistanceField}
 */
export function getDistanceField(track) {
  let field = cache.get(track);
  if (!field) {
    field = computeDistanceField(track);
    cache.set(track, field);
  }
  return field;
}

/**
 * @param {Track} track
 * @returns {DistanceField}
 */
export function computeDistanceField(track) {
  const width = track.width;
  const height = track.height;
  const stride = width + 1;
  const dist = new Float64Array(stride * (height + 1)).fill(Infinity);
  const heap = new MinHeap();

  /** A step from (x0,y0) to (x1,y1) is usable if it stays on the surface and clear of walls. */
  const stepOk = (/** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ x1, /** @type {number} */ y1) =>
    track.isOnTrackXY(x1, y1) && !track.segmentHitsWallXY(x0, y0, x1, y1);

  // Seeds: points from which a single step crosses the finish line forwards.
  for (let y = 0; y <= height; y++) {
    for (let x = 0; x <= width; x++) {
      if (!track.isOnTrackXY(x, y)) continue;
      const i = y * stride + x;
      for (const [dx, dy, cost] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (stepOk(x, y, nx, ny) && track.finishCrossingXY(x, y, nx, ny) === 1 && cost < dist[i]) {
          dist[i] = cost;
        }
      }
      if (dist[i] < Infinity) heap.push(dist[i], i);
    }
  }

  // Dijkstra backwards: relax every predecessor u of v whose step u→v does not
  // cross the finish line (in either direction).
  while (heap.size > 0) {
    const d = heap.peekKey();
    const v = heap.pop();
    if (d > dist[v]) continue; // stale heap entry
    const vx = v % stride;
    const vy = (v - vx) / stride;
    for (const [dx, dy, cost] of NEIGHBOURS) {
      const ux = vx + dx;
      const uy = vy + dy;
      if (!track.isOnTrackXY(ux, uy) || !stepOk(ux, uy, vx, vy)) continue;
      if (track.finishCrossingXY(ux, uy, vx, vy) !== 0) continue;
      const u = uy * stride + ux;
      const nd = d + cost;
      if (nd < dist[u]) {
        dist[u] = nd;
        heap.push(nd, u);
      }
    }
  }

  let lapLength = 0;
  for (const d of dist) if (d !== Infinity && d > lapLength) lapLength = d;
  return { width, height, stride, dist, lapLength };
}

/**
 * Distance to go for a point, or Infinity if off the grid / unreachable.
 * @param {DistanceField} field @param {number} x @param {number} y
 */
export function distanceAt(field, x, y) {
  if (x < 0 || y < 0 || x > field.width || y > field.height) return Infinity;
  return field.dist[y * field.stride + x];
}

/**
 * Remaining race distance for a car at (x, y) that has made `lapProgress` net
 * forward crossings in a race of `laps` laps.
 * @param {DistanceField} field @param {number} x @param {number} y
 * @param {number} lapProgress @param {number} laps
 */
export function raceDistance(field, x, y, lapProgress, laps) {
  const extraLaps = Math.max(0, laps - lapProgress - 1);
  return distanceAt(field, x, y) + extraLaps * field.lapLength;
}

/** Minimal binary heap of (numeric key, integer value) pairs. */
class MinHeap {
  constructor() {
    /** @type {number[]} */ this.keys = [];
    /** @type {number[]} */ this.values = [];
  }

  get size() {
    return this.keys.length;
  }

  peekKey() {
    return this.keys[0];
  }

  /** @param {number} key @param {number} value */
  push(key, value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  /** @returns {number} the value with the smallest key */
  pop() {
    const { keys, values } = this;
    const top = values[0];
    const lastKey = /** @type {number} */ (keys.pop());
    const lastValue = /** @type {number} */ (values.pop());
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        let smallestKey = lastKey;
        if (l < n && keys[l] < smallestKey) {
          smallest = l;
          smallestKey = keys[l];
        }
        if (r < n && keys[r] < smallestKey) smallest = r;
        if (smallest === i) break;
        keys[i] = keys[smallest];
        values[i] = values[smallest];
        i = smallest;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}
