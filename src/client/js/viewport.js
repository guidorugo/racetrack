/**
 * Mapping between grid coordinates and canvas (CSS pixel) coordinates.
 * Pure functions so they can be unit-tested without a browser.
 *
 * @typedef {Object} Viewport
 * @property {number} scale     CSS pixels per grid unit
 * @property {number} offsetX   CSS x of grid point (0, 0)
 * @property {number} offsetY   CSS y of grid point (0, 0)
 * @property {number} width     canvas CSS width
 * @property {number} height    canvas CSS height
 */

/**
 * Fits a grid of `gridWidth` x `gridHeight` units (plus a margin) into the canvas, centred.
 * @param {number} width @param {number} height
 * @param {number} gridWidth @param {number} gridHeight
 * @param {number} [margin] grid units of padding on each side
 * @returns {Viewport}
 */
export function computeViewport(width, height, gridWidth, gridHeight, margin = 1) {
  const scale = Math.max(1, Math.min(width / (gridWidth + 2 * margin), height / (gridHeight + 2 * margin)));
  return {
    scale,
    offsetX: (width - gridWidth * scale) / 2,
    offsetY: (height - gridHeight * scale) / 2,
    width,
    height,
  };
}

/** @param {Viewport} vp @param {number} x @param {number} y */
export function toScreen(vp, x, y) {
  return { x: vp.offsetX + x * vp.scale, y: vp.offsetY + y * vp.scale };
}

/** @param {Viewport} vp @param {number} sx @param {number} sy */
export function toGrid(vp, sx, sy) {
  return { x: (sx - vp.offsetX) / vp.scale, y: (sy - vp.offsetY) / vp.scale };
}

/**
 * Index of the option whose target is closest to the screen point, if within
 * `radiusPx`; otherwise -1.
 * @param {Viewport} vp
 * @param {ReadonlyArray<{ target: { x: number, y: number } }>} options
 * @param {number} sx @param {number} sy @param {number} radiusPx
 */
export function pickOption(vp, options, sx, sy, radiusPx) {
  let best = -1;
  let bestDist = radiusPx * radiusPx;
  options.forEach((o, i) => {
    const p = toScreen(vp, o.target.x, o.target.y);
    const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
    if (d <= bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/** Radius (CSS px) within which a click selects an option. @param {Viewport} vp */
export function pickRadius(vp) {
  return Math.max(10, vp.scale * 0.48);
}
