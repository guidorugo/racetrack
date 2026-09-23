/**
 * Game loop for single-player and local (hot-seat) games: runs the shared rules
 * engine in the browser, waits for human input and schedules bot moves.
 *
 * Game view <-> controller contract (shared with OnlineGameController):
 *   mode, getState(), getTrack(), canMove(), submitMove(acc), subscribe(fn),
 *   getLocalPlayerId(), dispose()
 * Events: { type: 'state', state, moves, reset } and { type: 'error', message }.
 *
 * @typedef {import('../../shared/game.js').GameState} GameState
 * @typedef {import('../../shared/game.js').MoveRecord} MoveRecord
 * @typedef {import('../../shared/game.js').PlayerConfig} PlayerConfig
 * @typedef {import('../../shared/track.js').Track} Track
 *
 * @typedef {{ type: 'state', state: GameState, moves: MoveRecord[], reset: boolean }
 *   | { type: 'error', message: string }
 *   | { type: 'meta' }} ControllerEvent
 *
 * @typedef {{ setTimeout: (fn: () => void, ms: number) => unknown, clearTimeout: (h: any) => void }} Scheduler
 */

import { chooseBotMove } from '../../shared/bot.js';
import { GameError } from '../../shared/errors.js';
import { applyMove, createGame, getCurrentPlayer } from '../../shared/game.js';
import { createRng, randomSeed } from '../../shared/rng.js';
import { errorMessage, t } from './i18n.js';

export class LocalController {
  /** @type {Track} */
  #track;
  /** @type {{ players: PlayerConfig[], laps: number }} */
  #config;
  /** @type {GameState} */
  #state;
  /** @type {Set<(event: ControllerEvent) => void>} */
  #listeners = new Set();
  /** @type {unknown} */
  #botTimer = null;
  #botDelayMs;
  #rng;
  /** @type {Scheduler} */
  #scheduler;
  #disposed = false;

  /**
   * @param {{
   *   mode: 'single' | 'local',
   *   track: Track,
   *   players: PlayerConfig[],
   *   laps?: number,
   *   botDelayMs?: number,
   *   seed?: number,
   *   scheduler?: Scheduler,
   * }} options
   */
  constructor({ mode, track, players, laps = 1, botDelayMs = 450, seed = randomSeed(), scheduler = globalThis }) {
    this.mode = mode;
    this.#track = track;
    this.#config = { players, laps };
    this.#botDelayMs = botDelayMs;
    this.#rng = createRng(seed);
    this.#scheduler = scheduler;
    this.#state = createGame(this.#config, track); // throws GameError on invalid setup
  }

  /** Emits the initial state and lets bots start if they move first. */
  start() {
    this.#emit({ type: 'state', state: this.#state, moves: [], reset: true });
    this.#scheduleBot();
  }

  /** Starts a fresh race with the same players and settings. */
  restart() {
    this.#cancelBot();
    this.#state = createGame(this.#config, this.#track);
    this.start();
  }

  getState() {
    return this.#state;
  }

  getTrack() {
    return this.#track;
  }

  /** In hot-seat play whoever's turn it is controls the car. */
  getLocalPlayerId() {
    return null;
  }

  canMove() {
    const current = getCurrentPlayer(this.#state);
    return !this.#disposed && current !== null && current.kind === 'human';
  }

  /** @param {{x: number, y: number}} acceleration @returns {boolean} whether the move was applied */
  submitMove(acceleration) {
    if (!this.canMove()) {
      this.#emit({ type: 'error', message: t('error.NOT_YOUR_TURN') });
      return false;
    }
    try {
      this.#apply(acceleration);
      return true;
    } catch (err) {
      const message = err instanceof GameError ? errorMessage(err.code, err.message) : t('error.MOVE_FAILED');
      if (!(err instanceof GameError)) console.error(err);
      this.#emit({ type: 'error', message });
      return false;
    }
  }

  /** @param {number} ms */
  setBotDelay(ms) {
    this.#botDelayMs = Math.max(0, ms);
  }

  /** @param {(event: ControllerEvent) => void} listener */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose() {
    this.#disposed = true;
    this.#cancelBot();
    this.#listeners.clear();
  }

  /** @param {{x: number, y: number}} acceleration */
  #apply(acceleration) {
    const { state, move } = applyMove(this.#state, this.#track, acceleration);
    this.#state = state;
    this.#emit({ type: 'state', state, moves: [move], reset: false });
    this.#scheduleBot();
  }

  #scheduleBot() {
    this.#cancelBot();
    const current = getCurrentPlayer(this.#state);
    if (this.#disposed || !current || current.kind !== 'bot') return;
    this.#botTimer = this.#scheduler.setTimeout(() => {
      this.#botTimer = null;
      const player = getCurrentPlayer(this.#state);
      if (this.#disposed || !player || player.kind !== 'bot') return;
      let acceleration = { x: 0, y: 0 };
      try {
        acceleration = chooseBotMove(this.#state, this.#track, { level: player.botLevel ?? 'medium', rng: this.#rng });
      } catch (err) {
        console.error('Bot failed to choose a move; coasting instead.', err);
      }
      this.#apply(acceleration);
    }, this.#botDelayMs);
  }

  #cancelBot() {
    if (this.#botTimer !== null) this.#scheduler.clearTimeout(this.#botTimer);
    this.#botTimer = null;
  }

  /** @param {ControllerEvent} event */
  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error('Game listener failed', err);
      }
    }
  }
}
