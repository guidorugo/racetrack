/** Shared fixtures for the test suite. */

import { Track } from '../../src/shared/track.js';

/**
 * A small square ring: outer wall (1,1)-(19,19), inner island (7,7)-(13,13).
 * The finish line crosses the bottom straight at x = 10 (from the island at
 * y = 13 to the outer wall at y = 19) and must be crossed eastwards.
 */
export const RING_DEFINITION = Object.freeze({
  id: 'test-ring',
  name: 'Test Ring',
  width: 20,
  height: 20,
  boundaries: [
    [[1, 1], [19, 1], [19, 19], [1, 19]],
    [[7, 7], [13, 7], [13, 13], [7, 13]],
  ],
  finishLine: { a: [10, 13], b: [10, 19] },
  direction: [1, 0],
  startPositions: [[10, 14], [10, 15], [10, 16], [10, 17]],
});

/** @param {object} [overrides] */
export function ringDefinition(overrides = {}) {
  return structuredClone({ ...RING_DEFINITION, ...overrides });
}

export function makeRingTrack() {
  return new Track(ringDefinition());
}

/**
 * Deterministic stand-in for setTimeout/clearTimeout/Date.now.
 * Timers only fire when the test advances time.
 */
export class FakeClock {
  #now;
  #nextId = 1;
  /** @type {Map<number, { at: number, fn: () => void, id: number }>} */
  #timers = new Map();

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now() {
    return this.#now;
  }

  /** @param {() => void} fn @param {number} ms */
  setTimeout(fn, ms) {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn, id });
    return id;
  }

  /** @param {unknown} id */
  clearTimeout(id) {
    this.#timers.delete(/** @type {number} */ (id));
  }

  /** @param {() => void} fn @param {number} ms */
  setInterval(fn, ms) {
    const id = this.#nextId++;
    const tick = () => {
      this.#timers.set(id, { at: this.#now + ms, fn: tick, id });
      fn();
    };
    this.#timers.set(id, { at: this.#now + ms, fn: tick, id });
    return id;
  }

  /** @param {unknown} id */
  clearInterval(id) {
    this.#timers.delete(/** @type {number} */ (id));
  }

  get pendingTimers() {
    return this.#timers.size;
  }

  /** Advances time, firing due timers in order (including ones they schedule). @param {number} ms */
  advance(ms) {
    const target = this.#now + ms;
    for (;;) {
      let next = null;
      for (const t of this.#timers.values()) {
        if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) break;
      this.#timers.delete(next.id);
      this.#now = next.at;
      next.fn();
    }
    this.#now = target;
  }
}

/** In-memory Connection for RoomManager tests. */
export class FakeConnection {
  /** @param {string} id */
  constructor(id) {
    this.id = id;
    /** @type {any[]} */
    this.messages = [];
    /** @type {{ code?: number, reason?: string } | null} */
    this.closed = null;
  }

  /** @param {string} text */
  send(text) {
    this.messages.push(JSON.parse(text));
  }

  /** @param {number} [code] @param {string} [reason] */
  close(code, reason) {
    this.closed = { code, reason };
  }

  /** @param {string} type */
  all(type) {
    return this.messages.filter((m) => m.type === type);
  }

  /** @param {string} type */
  last(type) {
    return this.all(type).at(-1);
  }

  /** Latest room snapshot received. */
  get room() {
    return this.last('room')?.room;
  }

  clear() {
    this.messages = [];
  }
}
