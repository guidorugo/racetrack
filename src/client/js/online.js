/**
 * Online play, client side.
 *
 * OnlineSession  — owns the WebSocket connection and the player's room membership:
 *                  create/join/resume/leave, lobby actions, moves. It stores the
 *                  session token per tab so a reload or a dropped connection
 *                  rejoins the same seat automatically.
 * OnlineGameController — adapts the session to the controller interface used by
 *                  the game view (same as LocalController).
 *
 * The server is authoritative: the client never applies moves itself, it only
 * renders the snapshots the server broadcasts.
 */

import { GameError } from '../../shared/errors.js';
import { getCurrentPlayer, isGameStateShape } from '../../shared/game.js';
import { ErrorCode, PROTOCOL_VERSION, WS_PATH } from '../../shared/protocol.js';
import { getTrack } from '../../shared/tracks/index.js';
import { ConnectionStatus } from './connection.js';
import { errorMessage, t } from './i18n.js';

const SESSION_KEY = 'online-session';
/** A seat we left while offline; the server must still be told. */
const PENDING_LEAVE_KEY = 'pending-leave';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {{ code: string, playerId: string, token: string }} StoredSession
 * @typedef {import('./connection.js').Connection} Connection
 * @typedef {import('./storage.js').Store} Store
 *
 * @typedef {{ type: 'room', room: any }
 *   | { type: 'status', status: string }
 *   | { type: 'left', reason: string }
 *   | { type: 'error', code: string, message: string, requestType: string | null }} SessionEvent
 */

/** Errors from online requests, with a protocol (or client-side) error code and a translated message. */
export class ServerError extends GameError {}

/** @param {string} code */
const clientError = (code) => new ServerError(code, t(`error.${code}`));

/** WebSocket URL on the same host that served the page. @param {{ protocol: string, host: string }} location */
export function socketUrlFor(location) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${WS_PATH}`;
}

/** Light structural check of a room snapshot received from the server. @param {any} room */
function isRoomShape(room) {
  return (
    room !== null &&
    typeof room === 'object' &&
    typeof room.code === 'string' &&
    typeof room.phase === 'string' &&
    Array.isArray(room.seats) &&
    (room.game === null || isGameStateShape(room.game))
  );
}

export class OnlineSession {
  /** @type {Connection} */
  #conn;
  /** @type {Store} */
  #store;
  #timers;
  #now;
  /** @type {Set<(event: SessionEvent) => void>} */
  #listeners = new Set();
  /** @type {null | { types: string[], message: object, sent: boolean, resolve: (v: any) => void, reject: (e: Error) => void, timer: unknown }} */
  #pending = null;
  /** @type {StoredSession | null} */
  #pendingLeave = null;
  #leaveSent = false;
  /** A cancelled create/join may still be answered; leave that room straight away. */
  #discardNextJoin = false;
  /** Latest room snapshot, or null when not in a room. */
  room = /** @type {any} */ (null);
  /** @type {string | null} */
  playerId = null;
  /** @type {string | null} */
  code = null;
  /** serverTime - localTime, to show server deadlines on the local clock. */
  clockOffset = 0;

  /**
   * @param {{ connection: Connection, store: Store, timers?: { setTimeout: Function, clearTimeout: Function }, now?: () => number }} deps
   */
  constructor({ connection, store, timers = globalThis, now = () => Date.now() }) {
    this.#conn = connection;
    this.#store = store;
    this.#timers = timers;
    this.#now = now;
    this.#pendingLeave = this.#readSession(PENDING_LEAVE_KEY);
    connection.onStatus((status) => this.#onStatus(status));
    connection.onMessage((message) => this.#onMessage(message));
  }

  /** @param {string} key @returns {StoredSession | null} */
  #readSession(key) {
    const s = this.#store.get(key, null);
    return s && typeof s.code === 'string' && typeof s.playerId === 'string' && typeof s.token === 'string' ? s : null;
  }

  get status() {
    return this.#conn.status;
  }

  /** @returns {StoredSession | null} */
  get storedSession() {
    return this.#readSession(SESSION_KEY);
  }

  /** True while a leave made offline still has to reach the server. */
  get hasPendingLeave() {
    return this.#pendingLeave !== null;
  }

  get isHost() {
    return !!this.room && this.room.hostId === this.playerId;
  }

  connect() {
    this.#conn.open();
  }

  retryNow() {
    this.#conn.retryNow();
  }

  /** @param {(event: SessionEvent) => void} fn */
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** @param {string} name @param {object} settings */
  createRoom(name, settings) {
    return this.#request({ type: 'create_room', name, settings }, ['create_room']);
  }

  /** @param {string} code @param {string} name */
  joinRoom(code, name) {
    return this.#request({ type: 'join_room', code, name }, ['join_room']);
  }

  /** Rejoins the seat saved for this tab. Resolves false if there is none. */
  async resume() {
    const saved = this.storedSession;
    if (!saved) return false;
    try {
      await this.#request({ type: 'resume', ...saved }, ['resume']);
      return true;
    } catch (err) {
      const code = /** @type {any} */ (err).code;
      if (code === ErrorCode.ROOM_NOT_FOUND || code === ErrorCode.INVALID_SESSION || code === ErrorCode.INVALID_ROOM_CODE) {
        this.#forgetRoom();
      }
      throw err;
    }
  }

  leaveRoom() {
    const seat = this.storedSession;
    const delivered = this.#conn.send({ type: 'leave_room' });
    this.#forgetRoom();
    if (!delivered && seat) {
      // Offline: the server still thinks we're in the race and would keep our car
      // going on autopilot. Remember to leave properly as soon as we're back.
      this.#pendingLeave = seat;
      this.#leaveSent = false;
      this.#store.set(PENDING_LEAVE_KEY, seat);
      this.#conn.open();
    }
  }

  /** Abandons a create/join/resume request the user no longer wants. */
  cancelPending() {
    const pending = this.#pending;
    if (!pending) return;
    // If it already went out, the server may still seat us: leave again at once.
    if (pending.sent && pending.types.some((t) => t === 'create_room' || t === 'join_room')) this.#discardNextJoin = true;
    this.#rejectPending(clientError('CANCELLED'));
  }

  /** Closes the connection when there is nothing left to do online. */
  disconnectIfIdle() {
    if (!this.room && !this.code && !this.#pending && !this.#pendingLeave && !this.#discardNextJoin) this.#conn.close();
  }

  /** @param {string} level */
  addBot(level) {
    return this.#send({ type: 'add_bot', level });
  }

  /** @param {string} playerId */
  removePlayer(playerId) {
    return this.#send({ type: 'remove_player', playerId });
  }

  /** @param {object} settings */
  updateSettings(settings) {
    return this.#send({ type: 'update_settings', settings });
  }

  startGame() {
    return this.#send({ type: 'start_game' });
  }

  /** @param {number} turn @param {{x: number, y: number}} acceleration */
  sendMove(turn, acceleration) {
    return this.#conn.send({ type: 'move', turn, acceleration });
  }

  dispose() {
    this.#rejectPending(clientError('DISCONNECTED'));
    this.#conn.close();
    this.#listeners.clear();
  }

  /** @param {object} message */
  #send(message) {
    const ok = this.#conn.send(message);
    if (!ok) this.#emit({ type: 'error', code: 'OFFLINE', message: t('error.OFFLINE'), requestType: null });
    return ok;
  }

  /**
   * Sends a request answered by `joined` (success) or an `error` naming one of `types`.
   * If the connection isn't open yet, the request goes out as soon as it is.
   * @param {object} message @param {string[]} types
   */
  #request(message, types) {
    if (this.#pending) return Promise.reject(clientError('BUSY'));
    return new Promise((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => {
        this.#pending = null;
        reject(clientError('TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
      this.#pending = { types, message, sent: false, resolve, reject, timer };
      this.#flushPending();
      this.#conn.open();
    });
  }

  #flushPending() {
    const pending = this.#pending;
    if (pending && !pending.sent && this.#conn.isOpen) pending.sent = this.#conn.send(pending.message);
  }

  /** @param {Error} error */
  #rejectPending(error) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#timers.clearTimeout(pending.timer);
    pending.reject(error);
  }

  /** @param {any} value */
  #resolvePending(value) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#timers.clearTimeout(pending.timer);
    pending.resolve(value);
  }

  #forgetRoom() {
    this.#store.remove(SESSION_KEY);
    this.room = null;
    this.code = null;
    this.playerId = null;
  }

  /** Tells the server about a leave made while offline: reclaim the seat, then leave it. */
  #flushPendingLeave() {
    const seat = this.#pendingLeave;
    if (!seat || this.#leaveSent) return;
    this.#leaveSent = this.#conn.send({ type: 'resume', ...seat }) && this.#conn.send({ type: 'leave_room' });
  }

  #completePendingLeave() {
    this.#pendingLeave = null;
    this.#leaveSent = false;
    this.#store.remove(PENDING_LEAVE_KEY);
  }

  /** @param {string} status */
  #onStatus(status) {
    if (status !== ConnectionStatus.OPEN) this.#leaveSent = false; // resend after reconnecting
    if (status === ConnectionStatus.OPEN) {
      this.#flushPendingLeave(); // must go first: requests below are answered after it
      if (this.#pending) this.#flushPending();
      else if (this.code && this.storedSession) {
        // Back after a drop: reclaim our seat.
        this.resume().catch((err) => {
          this.#emit({ type: 'left', reason: 'session-lost' });
          console.warn('Could not rejoin the room:', err.message);
        });
      }
    } else if (this.#pending?.sent) {
      // The request may or may not have reached the server; resend on reconnect.
      this.#pending.sent = false;
    }
    if (status === ConnectionStatus.FAILED) {
      this.#rejectPending(clientError('UNREACHABLE'));
    } else if (status === ConnectionStatus.REPLACED) {
      // Another tab took over this seat. Forget it here, or the two tabs would
      // keep stealing the seat back from each other.
      this.#rejectPending(clientError('REPLACED'));
      this.#forgetRoom();
      this.#emit({ type: 'left', reason: 'replaced' });
    }
    this.#emit({ type: 'status', status });
  }

  /** @param {any} msg */
  #onMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.#emit({ type: 'error', code: 'PROTOCOL_MISMATCH', message: t('error.PROTOCOL_MISMATCH'), requestType: null });
          this.#conn.close();
        }
        break;
      case 'joined':
        if (this.#leaveSent && this.#pendingLeave && msg.code === this.#pendingLeave.code && msg.playerId === this.#pendingLeave.playerId) {
          break; // reclaimed only in order to leave it (see #flushPendingLeave)
        }
        if (this.#discardNextJoin && !this.#pending) {
          this.#discardNextJoin = false;
          this.#conn.send({ type: 'leave_room' });
          break;
        }
        this.code = msg.code;
        this.playerId = msg.playerId;
        this.#store.set(SESSION_KEY, { code: msg.code, playerId: msg.playerId, token: msg.token });
        this.#resolvePending(msg);
        break;
      case 'room':
        if (!isRoomShape(msg.room)) {
          console.warn('Ignoring malformed room snapshot');
          break;
        }
        if (msg.room.code !== this.code) break; // stale message from a room we left
        this.room = msg.room;
        if (typeof msg.room.serverTime === 'number') this.clockOffset = msg.room.serverTime - this.#now();
        this.#emit({ type: 'room', room: msg.room });
        break;
      case 'left':
        if (this.#leaveSent) {
          this.#completePendingLeave(); // the answer to a leave made while offline
          break;
        }
        if (!this.code) break; // e.g. the answer to leaving a room we had already forgotten
        this.#forgetRoom();
        this.#emit({ type: 'left', reason: typeof msg.reason === 'string' ? msg.reason : 'left' });
        break;
      case 'error': {
        const pending = this.#pending;
        if (this.#leaveSent && (msg.requestType === 'resume' || msg.requestType === 'leave_room')) {
          break; // the seat we wanted to leave is already gone; the "left" reply completes it
        }
        if (pending && pending.types.includes(msg.requestType)) {
          this.#rejectPending(new ServerError(String(msg.code), errorMessage(String(msg.code), msg.message)));
        } else if (msg.code !== ErrorCode.SESSION_REPLACED) {
          this.#emit({ type: 'error', code: String(msg.code), message: errorMessage(String(msg.code), msg.message), requestType: msg.requestType ?? null });
        }
        break;
      }
      default:
        break; // pong
    }
  }

  /** @param {SessionEvent} event */
  #emit(event) {
    for (const fn of [...this.#listeners]) {
      try {
        fn(event);
      } catch (err) {
        console.error('Session listener failed', err);
      }
    }
  }
}

/** Move errors after which the player may simply try again. */
const MOVE_ERRORS = new Set([
  ErrorCode.STALE_TURN,
  ErrorCode.NOT_YOUR_TURN,
  ErrorCode.INVALID_ACCELERATION,
  ErrorCode.GAME_NOT_RUNNING,
  ErrorCode.GAME_OVER,
  ErrorCode.NOT_IN_ROOM,
]);

/** Game-view controller backed by the server. */
export class OnlineGameController {
  mode = /** @type {const} */ ('online');
  #session;
  /** @type {Set<(event: any) => void>} */
  #listeners = new Set();
  #unsubscribe;
  /** @type {any} */
  #lastGame;
  /** @type {number | null} */
  #lastRace;
  #moveInFlight = false;

  /** @param {OnlineSession} session */
  constructor(session) {
    this.#session = session;
    this.#lastGame = session.room?.game ?? null;
    this.#lastRace = session.room?.raceNumber ?? null;
    this.#unsubscribe = session.subscribe((event) => this.#onSessionEvent(event));
  }

  start() {
    if (this.#lastGame) this.#emit({ type: 'state', state: this.#lastGame, moves: [], reset: true });
  }

  getState() {
    return this.#session.room?.game ?? this.#lastGame;
  }

  getTrack() {
    return getTrack(this.getState().trackId);
  }

  getLocalPlayerId() {
    return this.#session.playerId;
  }

  get session() {
    return this.#session;
  }

  canMove() {
    const room = this.#session.room;
    const game = room?.game;
    return (
      !!game &&
      room.phase === 'playing' &&
      this.#session.status === ConnectionStatus.OPEN &&
      !this.#moveInFlight &&
      getCurrentPlayer(game)?.id === this.#session.playerId
    );
  }

  /** @param {{x: number, y: number}} acceleration */
  submitMove(acceleration) {
    if (!this.canMove()) {
      this.#emit({ type: 'error', message: t(this.#moveInFlight ? 'error.MOVE_IN_FLIGHT' : 'error.NOT_YOUR_TURN') });
      return false;
    }
    const game = this.#session.room.game;
    if (!this.#session.sendMove(game.turn, acceleration)) {
      this.#emit({ type: 'error', message: t('error.OFFLINE') });
      return false;
    }
    this.#moveInFlight = true;
    this.#emit({ type: 'meta' });
    return true;
  }

  /** Online-only information for the HUD. */
  getMeta() {
    const room = this.#session.room;
    const offset = this.#session.clockOffset;
    return {
      connection: this.#session.status,
      phase: room?.phase ?? null,
      seats: room?.seats ?? [],
      hostId: room?.hostId ?? null,
      isHost: this.#session.isHost,
      turnDeadline: room?.turnDeadline ? room.turnDeadline - offset : null,
      waitingFor: room?.waitingFor ? { playerId: room.waitingFor.playerId, until: room.waitingFor.until - offset } : null,
      moveInFlight: this.#moveInFlight,
    };
  }

  /** @param {(event: any) => void} fn */
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  dispose() {
    this.#unsubscribe();
    this.#listeners.clear();
  }

  /** @param {SessionEvent} event */
  #onSessionEvent(event) {
    if (event.type === 'room') {
      const game = event.room.game;
      if (!game) return;
      const prev = this.#lastGame;
      // A new race — even one that already has more moves than the last one, if we
      // missed its start while offline — is recognised by the server's race number.
      const race = typeof event.room.raceNumber === 'number' ? event.room.raceNumber : null;
      const newRace = race !== null && this.#lastRace !== null && race !== this.#lastRace;
      if (race !== null) this.#lastRace = race;
      const reset = !prev || newRace || game.turn < prev.turn || game.history.length < prev.history.length;
      const moves = reset ? [] : game.history.slice(prev.history.length);
      this.#lastGame = game;
      if (reset || moves.length > 0 || event.room.phase !== 'playing') this.#moveInFlight = false;
      // Always forward the snapshot: the state can change without a new move
      // (e.g. a player retires and the turn passes on).
      this.#emit({ type: 'state', state: game, moves, reset });
    } else if (event.type === 'error') {
      if (MOVE_ERRORS.has(event.code)) {
        this.#moveInFlight = false;
        this.#emit({ type: 'error', message: event.message });
      }
    } else if (event.type === 'status') {
      if (event.status !== ConnectionStatus.OPEN) this.#moveInFlight = false;
      this.#emit({ type: 'meta' });
    }
  }

  /** @param {any} event */
  #emit(event) {
    for (const fn of [...this.#listeners]) {
      try {
        fn(event);
      } catch (err) {
        console.error('Game listener failed', err);
      }
    }
  }
}
