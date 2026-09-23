/**
 * The default track: a stadium-shaped oval, 8 grid units wide all the way round.
 *
 * Grid: 60 x 38 units. The outer wall spans x 3..57 / y 3..35 and the inner
 * island x 11..49 / y 11..27. The bends are convex lattice polygons approximating
 * circles of radius 16 (outside) and 8 (inside) centred on (19, 19) and (41, 19),
 * so every vertex is an integer grid point and collision checks stay exact.
 *
 * The start/finish line crosses the bottom straight at x = 30 and cars race
 * counter-clockwise on screen: east along the bottom straight, north up the right
 * bend, west along the top straight and back down the left bend.
 *
 * @type {import('../track.js').TrackDefinition}
 */
export const OVAL_TRACK = {
  id: 'oval',
  name: 'Classic Oval',
  description: 'A wide stadium oval with two long straights. Race counter-clockwise; one lap wins.',
  width: 60,
  height: 38,
  boundaries: [
    // Outer wall
    [
      [16, 3], [44, 3], [48, 4], [52, 7], [53, 8], [56, 12], [57, 16], [57, 22],
      [56, 26], [53, 30], [52, 31], [48, 34], [44, 35], [16, 35], [12, 34], [8, 31],
      [7, 30], [4, 26], [3, 22], [3, 16], [4, 12], [7, 8], [8, 7], [12, 4],
    ],
    // Inner island
    [
      [17, 11], [43, 11], [46, 12], [48, 14], [49, 17], [49, 21], [48, 24], [46, 26],
      [43, 27], [17, 27], [14, 26], [12, 24], [11, 21], [11, 17], [12, 14], [14, 12],
    ],
  ],
  finishLine: { a: [30, 27], b: [30, 35] },
  direction: [1, 0],
  startPositions: [
    [30, 28],
    [30, 30],
    [30, 32],
    [30, 34],
  ],
};
