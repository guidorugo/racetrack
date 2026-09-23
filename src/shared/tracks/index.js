/**
 * Track registry. To add a track, create a definition file next to `oval.js`
 * (see `TrackDefinition` in ../track.js) and append it to `DEFINITIONS` below.
 * Definitions are validated when the registry is built, so a broken track fails
 * fast at start-up (and in the test suite) instead of mid-game.
 */

import { EngineErrors, GameError } from '../errors.js';
import { Track } from '../track.js';
import { OVAL_TRACK } from './oval.js';

const DEFINITIONS = [OVAL_TRACK];

/** @type {Map<string, Track>} */
const registry = new Map();
for (const def of DEFINITIONS) {
  if (registry.has(def.id)) throw new Error(`Duplicate track id "${def.id}"`);
  registry.set(def.id, new Track(def));
}

export const DEFAULT_TRACK_ID = OVAL_TRACK.id;

/** @param {unknown} id */
export function hasTrack(id) {
  return typeof id === 'string' && registry.has(id);
}

/**
 * @param {string} id
 * @returns {Track}
 */
export function getTrack(id) {
  const track = typeof id === 'string' ? registry.get(id) : undefined;
  if (!track) throw new GameError(EngineErrors.UNKNOWN_TRACK, `Unknown track "${String(id)}".`);
  return track;
}

/** @returns {{ id: string, name: string, description: string }[]} */
export function listTracks() {
  return [...registry.values()].map((t) => ({ id: t.id, name: t.name, description: t.description }));
}
