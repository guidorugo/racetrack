/**
 * Live race order: finished cars in the order they finished, then racing cars
 * by distance still to go, then retired cars.
 *
 * @typedef {import('./track.js').Track} Track
 * @typedef {import('./game.js').GameState} GameState
 *
 * @typedef {Object} Standing
 * @property {string} playerId
 * @property {number} rank          1-based.
 * @property {number} remaining     Race distance still to go in grid units (0 once finished).
 * @property {import('./game.js').CarStatus} status
 */

import { getDistanceField, raceDistance } from './distanceField.js';

const STATUS_ORDER = { finished: 0, racing: 1, retired: 2 };

/**
 * @param {GameState} state
 * @param {Track} track
 * @returns {Standing[]} sorted by rank
 */
export function computeStandings(state, track) {
  const field = getDistanceField(track);
  const rows = state.players.map((p, seat) => ({
    playerId: p.id,
    seat,
    status: p.status,
    place: p.place ?? 0,
    remaining:
      p.status === 'finished' ? 0 : raceDistance(field, p.position.x, p.position.y, p.lapProgress, state.laps),
  }));
  rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.place - b.place || a.remaining - b.remaining || a.seat - b.seat,
  );
  return rows.map((r, i) => ({ playerId: r.playerId, rank: i + 1, remaining: r.remaining, status: r.status }));
}
