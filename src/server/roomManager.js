/**
 * Server-side game coordination for online play.
 *
 * The RoomManager owns all rooms and is the single authority over game state:
 * clients only *request* moves; the manager validates them against the shared
 * rules engine, applies them, and broadcasts the resulting snapshot to everyone
 * in the room, so all players always see the same state.
 *
 * It is transport-agnostic (the WebSocket layer hands it `Connection` objects)
 * and takes an injectable clock, which keeps it fully unit-testable.
 *
 * Turn coordination:
 *  - Only the player whose turn it is may move, and a move must name the turn
 *    number it was made for, so duplicates and stale clicks are rejected.
 *  - Bot seats move automatically after a short delay.
 *  - A disconnected player keeps their seat and has `reconnectGraceMs` (counted
 *    from the moment they dropped) to come back. If their turn comes up while they
 *    are still away, the race waits out what is left of that grace period; after
 *    that an autopilot drives their car until they reconnect.
 *  - With a per-turn time limit, an idle (connected) player's move is made by the
 *    autopilot when the timer runs out. The deadline belongs to the turn: dropping
 *    and resuming (or resuming from another tab) never extends it.
 *
 * @typedef {import('../shared/game.js').GameState} GameState
 * @typedef {import('../shared/protocol.js').RoomSettings} RoomSettings
 * @typedef {import('../shared/constants.js').BotLevel} BotLevel
 *
 * @typedef {Object} Connection
 * @property {string} id
 * @property {string} [ip]                   Client address, for per-address limits.
 * @property {(text: string) => void} send   Sends an already-serialised message.
 * @property {(code?: number, reason?: string) => void} close
 *
 * @typedef {Object} Clock
 * @property {() => number} now
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 *
 * @typedef {Object} Logger
 * @property {(msg: string, ctx?: object) => void} debug
 * @property {(msg: string, ctx?: object) => void} info
 * @property {(msg: string, ctx?: object) => void} warn
 * @property {(msg: string, ctx?: object) => void} error
 *
 * @typedef {Object} Seat
 * @property {string} playerId
 * @property {string} name
 * @property {'human' | 'bot'} kind
 * @property {BotLevel | null} botLevel
 * @property {string | null} token      Reconnection secret (humans only).
 * @property {string | null} connId
 * @property {boolean} connected
 * @property {number | null} disconnectedAt
 * @property {boolean} autopilot        Server is driving this human's car.
 * @property {boolean} left             Left mid-race; kept until the race ends.
 * @property {unknown} graceTimer       Pending removal of a disconnected lobby seat.
 *
 * @typedef {Object} Room
 * @property {string} code
 * @property {'lobby' | 'playing' | 'finished'} phase
 * @property {string} hostId
 * @property {RoomSettings} settings
 * @property {Seat[]} seats
 * @property {number} nextPlayerNumber
 * @property {GameState | null} game
 * @property {number} raceNumber         Increases with every race started in the room.
 * @property {string | null} creatorIp
 * @property {unknown} turnTimer
 * @property {number | null} turnDeadline
 * @property {{ turn: number, playerId: string, deadline: number } | null} turnClock
 * @property {{ playerId: string, until: number } | null} waitingFor
 * @property {unknown} closeTimer
 * @property {number} createdAt
 * @property {number} lastActivity
 * @property {number} version
 *
 * @typedef {Object} ClientState
 * @property {Connection} conn
 * @property {string | null} roomCode
 * @property {string | null} playerId
 * @property {number} tokens
 * @property {number} lastRefill
 * @property {number} dropped          Messages dropped in the current rate-limit window.
 * @property {number} dropWindowStart
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chooseBotMove } from '../shared/bot.js';
import { BOT_NAMES, MAX_NAME_LENGTH, MAX_PLAYERS, PLAYER_COLORS } from '../shared/constants.js';
import { GameError } from '../shared/errors.js';
import { applyMove, createGame, getCurrentPlayer, retirePlayer } from '../shared/game.js';
import {
  ClientMessage,
  CloseCode,
  ErrorCode,
  MIN_ONLINE_PLAYERS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ServerMessage,
  isBotLevel,
  normalizeRoomCode,
  parseClientMessage,
  validateRoomSettings,
} from '../shared/protocol.js';
import { getTrack } from '../shared/tracks/index.js';
import { sanitizeName } from '../shared/validation.js';

export const DEFAULT_MANAGER_OPTIONS = Object.freeze({
  /** Pause before a bot (or the autopilot) moves, so humans can follow the action. */
  botMoveDelayMs: 700,
  /** How long the race waits for a disconnected player whose turn it is. */
  reconnectGraceMs: 30_000,
  /** How long a disconnected player's seat is kept in the lobby / after a race. */
  lobbyGraceMs: 60_000,
  /** A room with no connected humans is closed after this long. */
  emptyRoomTtlMs: 5 * 60_000,
  /** Any room without activity for this long is closed. */
  idleRoomTtlMs: 2 * 60 * 60_000,
  /** How often idle rooms are swept. */
  sweepIntervalMs: 60_000,
  maxRooms: 500,
  /** Open rooms a single client address may have created at once. */
  maxRoomsPerIp: 10,
  /** Skill of the autopilot that drives for absent / timed-out players. */
  autopilotLevel: /** @type {BotLevel} */ ('medium'),
  /** Token bucket per connection. */
  rateLimitCapacity: 30,
  rateLimitPerSecond: 15,
  /** A connection with more dropped messages than this within one window is closed. */
  rateLimitMaxDropped: 200,
  rateLimitWindowMs: 10_000,
});

/** @type {Clock} */
export const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(/** @type {any} */ (handle)),
};

/** @type {Logger} */
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
function fail(code, message, details) {
  return new GameError(code, message, details);
}

export class RoomManager {
  /** @type {Map<string, ClientState>} */
  #clients = new Map();
  /** @type {Map<string, Room>} */
  #rooms = new Map();
  /** @type {Clock} */
  #clock;
  /** @type {Logger} */
  #logger;
  /** @type {typeof DEFAULT_MANAGER_OPTIONS} */
  #options;
  /** @type {() => number} */
  #rng;
  /** @type {unknown} */
  #sweepTimer = null;
  #disposed = false;

  /**
   * @param {{ clock?: Clock, logger?: Logger, options?: Partial<typeof DEFAULT_MANAGER_OPTIONS>, rng?: () => number }} [deps]
   */
  constructor(deps = {}) {
    this.#clock = deps.clock ?? systemClock;
    this.#logger = deps.logger ?? silentLogger;
    this.#options = { ...DEFAULT_MANAGER_OPTIONS, ...deps.options };
    this.#rng = deps.rng ?? Math.random;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** Starts the periodic idle-room sweep. */
  start() {
    const tick = () => {
      this.sweep();
      if (!this.#disposed) this.#sweepTimer = this.#clock.setTimeout(tick, this.#options.sweepIntervalMs);
    };
    this.#sweepTimer = this.#clock.setTimeout(tick, this.#options.sweepIntervalMs);
  }

  /** Stops all timers and forgets all rooms (used on shutdown). */
  dispose() {
    this.#disposed = true;
    if (this.#sweepTimer) this.#clock.clearTimeout(this.#sweepTimer);
    for (const room of [...this.#rooms.values()]) this.#closeRoom(room, 'server-shutdown');
    this.#clients.clear();
  }

  /** Closes rooms that have been idle for too long. */
  sweep() {
    const now = this.#clock.now();
    for (const room of [...this.#rooms.values()]) {
      if (now - room.lastActivity > this.#options.idleRoomTtlMs) {
        this.#logger.info('closing idle room', { room: room.code });
        this.#closeRoom(room, 'idle');
      }
    }
  }

  stats() {
    return { rooms: this.#rooms.size, connections: this.#clients.size };
  }

  /** @param {string} code Test/inspection helper: a snapshot of the room as clients see it. */
  getRoomView(code) {
    const room = this.#rooms.get(code);
    return room ? this.#view(room) : null;
  }

  // ---------------------------------------------------------------------------
  // Transport entry points

  /** @param {Connection} conn */
  addConnection(conn) {
    const now = this.#clock.now();
    this.#clients.set(conn.id, {
      conn,
      roomCode: null,
      playerId: null,
      tokens: this.#options.rateLimitCapacity,
      lastRefill: now,
      dropped: 0,
      dropWindowStart: now,
    });
    this.#send(conn.id, { type: ServerMessage.WELCOME, protocol: PROTOCOL_VERSION, serverTime: now });
  }

  /** @param {string} connId */
  removeConnection(connId) {
    const client = this.#clients.get(connId);
    if (!client) return;
    this.#clients.delete(connId);
    const found = this.#findSeat(client);
    if (!found || found.seat.connId !== connId) return;
    const { room, seat } = found;
    seat.connId = null;
    seat.connected = false;
    seat.disconnectedAt = this.#clock.now();
    this.#logger.info('player disconnected', { room: room.code, player: seat.playerId });
    if (room.phase === 'playing') this.#onPresenceChanged(room, seat);
    else this.#startSeatGrace(room, seat);
    this.#updateEmptyRoomTimer(room);
    this.#broadcast(room);
  }

  /**
   * @param {string} connId
   * @param {unknown} raw  text frame contents
   */
  handleRawMessage(connId, raw) {
    const client = this.#clients.get(connId);
    if (!client) return;
    if (!this.#takeToken(client)) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.#sendError(connId, parsed.code, parsed.error);
      return;
    }
    const { message } = parsed;
    try {
      this.#dispatch(client, message);
    } catch (err) {
      if (err instanceof GameError) {
        this.#sendError(connId, err.code, err.message, message.type, err.details);
      } else {
        this.#logger.error('unexpected error handling message', { type: message.type, err: String(err?.stack ?? err) });
        this.#sendError(connId, ErrorCode.INTERNAL_ERROR, 'Something went wrong on the server.', message.type);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Message handlers

  /** @param {ClientState} client @param {Record<string, any> & { type: string }} msg */
  #dispatch(client, msg) {
    switch (msg.type) {
      case ClientMessage.PING:
        return this.#send(client.conn.id, { type: ServerMessage.PONG, serverTime: this.#clock.now() });
      case ClientMessage.CREATE_ROOM:
        return this.#onCreateRoom(client, msg);
      case ClientMessage.JOIN_ROOM:
        return this.#onJoinRoom(client, msg);
      case ClientMessage.RESUME:
        return this.#onResume(client, msg);
      case ClientMessage.LEAVE_ROOM:
        return this.#onLeaveRoom(client);
      case ClientMessage.ADD_BOT:
        return this.#onAddBot(client, msg);
      case ClientMessage.REMOVE_PLAYER:
        return this.#onRemovePlayer(client, msg);
      case ClientMessage.UPDATE_SETTINGS:
        return this.#onUpdateSettings(client, msg);
      case ClientMessage.START_GAME:
        return this.#onStartGame(client);
      case ClientMessage.MOVE:
        return this.#onMove(client, msg);
      default:
        throw fail(ErrorCode.UNKNOWN_TYPE, `Unknown message type "${msg.type}".`);
    }
  }

  /** @param {ClientState} client @param {Record<string, any>} msg */
  #onCreateRoom(client, msg) {
    this.#requireNoRoom(client);
    if (this.#rooms.size >= this.#options.maxRooms) {
      throw fail(ErrorCode.SERVER_FULL, 'The server has reached its room limit. Please try again later.');
    }
    const ip = client.conn.ip ?? null;
    if (ip && [...this.#rooms.values()].filter((r) => r.creatorIp === ip).length >= this.#options.maxRoomsPerIp) {
      throw fail(ErrorCode.TOO_MANY_ROOMS, 'Too many rooms are open from your network. Leave one before creating another.');
    }
    const name = this.#requireName(msg.name);
    const settings = validateRoomSettings(msg.settings);
    if (!settings.ok) throw fail(ErrorCode.INVALID_SETTINGS, settings.error);
    const now = this.#clock.now();
    /** @type {Room} */
    const room = {
      code: this.#newRoomCode(),
      phase: 'lobby',
      hostId: '',
      settings: settings.settings,
      seats: [],
      nextPlayerNumber: 1,
      game: null,
      raceNumber: 0,
      creatorIp: ip,
      turnTimer: null,
      turnDeadline: null,
      turnClock: null,
      waitingFor: null,
      closeTimer: null,
      createdAt: now,
      lastActivity: now,
      version: 0,
    };
    this.#rooms.set(room.code, room);
    const seat = this.#addHumanSeat(room, client, name);
    room.hostId = seat.playerId;
    this.#logger.info('room created', { room: room.code, host: seat.playerId });
    this.#sendJoined(client, room, seat);
    this.#broadcast(room);
  }

  /** @param {ClientState} client @param {Record<string, any>} msg */
  #onJoinRoom(client, msg) {
    this.#requireNoRoom(client);
    const room = this.#requireRoom(msg.code);
    const name = this.#requireName(msg.name);
    if (room.phase === 'playing') throw fail(ErrorCode.GAME_IN_PROGRESS, 'That race has already started.');
    if (room.seats.length >= MAX_PLAYERS) throw fail(ErrorCode.ROOM_FULL, 'That room is full.');
    const seat = this.#addHumanSeat(room, client, this.#uniqueName(room, name));
    this.#logger.info('player joined', { room: room.code, player: seat.playerId });
    this.#sendJoined(client, room, seat);
    this.#broadcast(room);
  }

  /** @param {ClientState} client @param {Record<string, any>} msg */
  #onResume(client, msg) {
    const room = this.#requireRoom(msg.code);
    const seat = room.seats.find((s) => s.playerId === msg.playerId && s.kind === 'human' && !s.left);
    if (!seat || !seat.token || !tokensEqual(seat.token, msg.token)) {
      throw fail(ErrorCode.INVALID_SESSION, 'That session is no longer valid.');
    }
    if (client.roomCode && (client.roomCode !== room.code || client.playerId !== seat.playerId)) {
      throw fail(ErrorCode.ALREADY_IN_ROOM, 'Leave your current room first.');
    }
    const wasConnected = seat.connected;
    // Take over from another live connection (e.g. the same player in a new tab).
    if (seat.connId && seat.connId !== client.conn.id) {
      const previous = this.#clients.get(seat.connId);
      if (previous) {
        previous.roomCode = null;
        previous.playerId = null;
        this.#sendError(previous.conn.id, ErrorCode.SESSION_REPLACED, 'You joined this race from another window.');
        previous.conn.close(CloseCode.SESSION_REPLACED, 'Session replaced');
      }
    }
    this.#attach(client, room, seat);
    this.#sendJoined(client, room, seat);
    if (wasConnected) {
      // Same player, same seat, still connected (a repeated resume or another tab):
      // nothing changed for anyone else, and timers must not be reset.
      this.#sendText(client.conn.id, JSON.stringify({ type: ServerMessage.ROOM, room: this.#view(room) }));
      return;
    }
    this.#logger.info('player resumed', { room: room.code, player: seat.playerId });
    if (room.phase === 'playing') this.#onPresenceChanged(room, seat);
    this.#broadcast(room);
  }

  /** @param {ClientState} client */
  #onLeaveRoom(client) {
    const found = this.#findSeat(client);
    client.roomCode = null;
    client.playerId = null;
    this.#send(client.conn.id, { type: ServerMessage.LEFT, reason: 'left' });
    if (!found) return;
    const { room, seat } = found;
    seat.connId = null;
    seat.connected = false;
    this.#logger.info('player left', { room: room.code, player: seat.playerId });
    this.#removeSeat(room, seat);
  }

  /** @param {ClientState} client @param {Record<string, any>} msg */
  #onAddBot(client, msg) {
    const { room, seat } = this.#requireSeat(client);
    this.#requireHost(room, seat);
    this.#requireNotPlaying(room);
    if (!isBotLevel(msg.level)) throw fail(ErrorCode.BAD_MESSAGE, 'Unknown bot level.');
    if (room.seats.length >= MAX_PLAYERS) throw fail(ErrorCode.ROOM_FULL, 'The room is full.');
    const number = room.nextPlayerNumber++;
    const botName = this.#uniqueName(room, `${BOT_NAMES[(number - 1) % BOT_NAMES.length]} (bot)`);
    room.seats.push(this.#newSeat(`p${number}`, botName, 'bot', msg.level));
    this.#touch(room);
    this.#broadcast(room);
  }

  /** @param {ClientState} client @param {Record<string, any>} msg */
  #onRemovePlayer(client, msg) {
    const { room, seat } = this.#requireSeat(client);
    this.#requireHost(room, seat);
    this.#requireNotPlaying(room);
    const target = room.seats.find((s) => s.playerId === msg.playerId);
    if (!target) throw fail(ErrorCode.UNKNOWN_PLAYER, 'No such player in this room.');
    if (target === seat) throw fail(ErrorCode.UNKNOWN_PLAYER, 'Use "Leave" to leave the room yourself.');
    if (target.connId) {
      const kicked = this.#clients.get(target.connId);
      if (kicked) {
        kicked.roomCode = null;
        kicked.playerId = null;
        this.#send(kicked.conn.id, { type: ServerMessage.LEFT, reason: 'kicked' });
      }
    }
    this.#removeSeat(room, target);
  }

  /** @param {ClientState} client @param {Record<string, any>} msg */
  #onUpdateSettings(client, msg) {
    const { room, seat } = this.#requireSeat(client);
    this.#requireHost(room, seat);
    this.#requireNotPlaying(room);
    const result = validateRoomSettings(msg.settings, room.settings);
    if (!result.ok) throw fail(ErrorCode.INVALID_SETTINGS, result.error);
    room.settings = result.settings;
    this.#touch(room);
    this.#broadcast(room);
  }

  /** @param {ClientState} client */
  #onStartGame(client) {
    const { room, seat } = this.#requireSeat(client);
    this.#requireHost(room, seat);
    this.#requireNotPlaying(room);
    if (room.seats.length < MIN_ONLINE_PLAYERS) {
      throw fail(ErrorCode.NOT_ENOUGH_PLAYERS, `At least ${MIN_ONLINE_PLAYERS} players are needed (add a bot?).`);
    }
    const track = getTrack(room.settings.trackId);
    room.game = createGame(
      {
        players: room.seats.map((s) => ({ id: s.playerId, name: s.name, kind: s.kind, botLevel: s.botLevel ?? undefined })),
        laps: room.settings.laps,
      },
      track,
    );
    room.phase = 'playing';
    room.raceNumber += 1;
    room.turnClock = null;
    for (const s of room.seats) {
      s.autopilot = false;
      this.#clearSeatGrace(s);
    }
    this.#touch(room);
    this.#logger.info('race started', { room: room.code, players: room.seats.length });
    this.#scheduleTurn(room);
    this.#broadcast(room);
  }

  /** @param {ClientState} client @param {Record<string, any>} msg */
  #onMove(client, msg) {
    const { room, seat } = this.#requireSeat(client);
    if (room.phase !== 'playing' || !room.game) throw fail(ErrorCode.GAME_NOT_RUNNING, 'No race is running.');
    if (msg.turn !== room.game.turn) {
      throw fail(ErrorCode.STALE_TURN, 'That move was for an earlier turn.', { turn: room.game.turn });
    }
    const current = getCurrentPlayer(room.game);
    if (!current || current.id !== seat.playerId) {
      throw fail(ErrorCode.NOT_YOUR_TURN, current ? `It is ${current.name}'s turn.` : 'The race is over.');
    }
    this.#applyMove(room, msg.acceleration, null);
  }

  // ---------------------------------------------------------------------------
  // Turn automation

  /**
   * Applies a move for the current player, then schedules whatever comes next.
   * @param {Room} room @param {unknown} acceleration @param {string | null} note
   */
  #applyMove(room, acceleration, note) {
    if (!room.game) return;
    const track = getTrack(room.game.trackId);
    const { state } = applyMove(room.game, track, acceleration, { note });
    room.game = state;
    this.#touch(room);
    if (state.status === 'finished') this.#finishRace(room);
    else this.#scheduleTurn(room);
    this.#broadcast(room);
  }

  /** @param {Room} room */
  #finishRace(room) {
    room.phase = 'finished';
    this.#clearTurnTimer(room);
    this.#logger.info('race finished', { room: room.code, winner: room.game?.winnerId, reason: room.game?.endReason });
    // Drop seats of players who left mid-race; disconnected players get a grace period.
    room.seats = room.seats.filter((s) => !s.left);
    for (const seat of room.seats) if (seat.kind === 'human' && !seat.connected) this.#startSeatGrace(room, seat);
    this.#ensureHost(room);
  }

  /**
   * A player connected or disconnected mid-race. Only the current player's
   * timer is affected — other players' deadlines must not be reset.
   * @param {Room} room @param {Seat} seat
   */
  #onPresenceChanged(room, seat) {
    const current = room.game && getCurrentPlayer(room.game);
    const paused = !room.turnTimer; // nothing pending, e.g. the race was paused
    if (paused || current?.id === seat.playerId || !this.#anyHumanConnected(room)) this.#scheduleTurn(room);
  }

  /** @param {Room} room */
  #anyHumanConnected(room) {
    return room.seats.some((s) => s.kind === 'human' && s.connected);
  }

  /**
   * Arranges the next automatic action for the player whose turn it is:
   * a bot move, an autopilot move, a reconnection wait, or a turn time limit.
   * While no human is connected the race is paused (nothing is scheduled).
   * @param {Room} room
   */
  #scheduleTurn(room) {
    this.#clearTurnTimer(room);
    if (room.phase !== 'playing' || !room.game || room.game.status !== 'playing') return;
    if (!this.#anyHumanConnected(room)) {
      room.turnClock = null; // paused: whoever comes back gets a full turn
      return;
    }
    const current = getCurrentPlayer(room.game);
    const seat = current && room.seats.find((s) => s.playerId === current.id);
    if (!current || !seat) return;
    const expected = { turn: room.game.turn, playerId: current.id };
    const { botMoveDelayMs, reconnectGraceMs } = this.#options;

    if (seat.kind === 'bot' || seat.autopilot) {
      const note = seat.kind === 'bot' ? null : 'autopilot';
      room.turnTimer = this.#timer(() => this.#autoMove(room, expected, note), botMoveDelayMs);
      return;
    }
    if (!seat.connected) {
      const until = (seat.disconnectedAt ?? this.#clock.now()) + reconnectGraceMs;
      room.waitingFor = { playerId: seat.playerId, until };
      room.turnTimer = this.#timer(() => {
        room.turnTimer = null;
        if (!this.#isExpectedTurn(room, expected) || seat.connected) return;
        seat.autopilot = true;
        this.#logger.info('autopilot engaged', { room: room.code, player: seat.playerId });
        this.#scheduleTurn(room);
        this.#broadcast(room);
      }, Math.max(0, until - this.#clock.now()));
      return;
    }
    const limit = room.settings.turnTimeLimit;
    if (limit > 0) {
      const clock = room.turnClock;
      if (!clock || clock.turn !== expected.turn || clock.playerId !== expected.playerId) {
        room.turnClock = { ...expected, deadline: this.#clock.now() + limit * 1000 };
      }
      const deadline = /** @type {{ deadline: number }} */ (room.turnClock).deadline;
      room.turnDeadline = deadline;
      room.turnTimer = this.#timer(() => this.#autoMove(room, expected, 'timeout'), Math.max(0, deadline - this.#clock.now()));
    }
  }

  /**
   * Whether the race is still at the turn a timer was scheduled for.
   * @param {Room} room @param {{ turn: number, playerId: string }} expected
   */
  #isExpectedTurn(room, expected) {
    const game = room.game;
    return (
      room.phase === 'playing' &&
      !!game &&
      game.status === 'playing' &&
      game.turn === expected.turn &&
      getCurrentPlayer(game)?.id === expected.playerId
    );
  }

  /**
   * @param {Room} room
   * @param {{ turn: number, playerId: string }} expected  the turn this action was scheduled for
   * @param {string | null} note   null for bots, otherwise why the server moved
   */
  #autoMove(room, expected, note) {
    room.turnTimer = null;
    if (!this.#isExpectedTurn(room, expected)) return; // superseded
    const game = /** @type {GameState} */ (room.game);
    const current = /** @type {import('../shared/game.js').PlayerState} */ (getCurrentPlayer(game));
    const seat = room.seats.find((s) => s.playerId === current.id);
    if (!seat) return;
    const track = getTrack(game.trackId);
    const level = seat.kind === 'bot' && seat.botLevel ? seat.botLevel : this.#options.autopilotLevel;
    let acceleration;
    try {
      acceleration = chooseBotMove(game, track, { level, rng: this.#rng });
    } catch (err) {
      this.#logger.error('bot failed to choose a move; coasting', { room: room.code, err: String(err) });
      acceleration = { x: 0, y: 0 };
    }
    this.#applyMove(room, acceleration, note);
  }

  /** @param {Room} room */
  #clearTurnTimer(room) {
    if (room.turnTimer) this.#clock.clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.turnDeadline = null;
    room.waitingFor = null;
  }

  // ---------------------------------------------------------------------------
  // Seats & rooms

  /** @param {string} playerId @param {string} name @param {'human' | 'bot'} kind @param {BotLevel | null} botLevel @returns {Seat} */
  #newSeat(playerId, name, kind, botLevel) {
    return {
      playerId,
      name,
      kind,
      botLevel,
      token: kind === 'human' ? randomBytes(18).toString('base64url') : null,
      connId: null,
      connected: kind === 'human',
      disconnectedAt: null,
      autopilot: false,
      left: false,
      graceTimer: null,
    };
  }

  /** @param {Room} room @param {ClientState} client @param {string} name */
  #addHumanSeat(room, client, name) {
    const seat = this.#newSeat(`p${room.nextPlayerNumber++}`, name, 'human', null);
    room.seats.push(seat);
    this.#attach(client, room, seat);
    return seat;
  }

  /** Binds a connection to a seat. @param {ClientState} client @param {Room} room @param {Seat} seat */
  #attach(client, room, seat) {
    client.roomCode = room.code;
    client.playerId = seat.playerId;
    seat.connId = client.conn.id;
    seat.connected = true;
    seat.disconnectedAt = null;
    seat.autopilot = false;
    this.#clearSeatGrace(seat);
    this.#touch(room);
    this.#updateEmptyRoomTimer(room);
  }

  /**
   * Removes a player from the room. Mid-race their car is retired instead, so the
   * race record stays intact.
   * @param {Room} room @param {Seat} seat
   */
  #removeSeat(room, seat) {
    this.#clearSeatGrace(seat);
    if (room.phase === 'playing' && room.game) {
      const wasCurrent = getCurrentPlayer(room.game)?.id === seat.playerId;
      seat.left = true;
      seat.autopilot = false;
      room.game = retirePlayer(room.game, seat.playerId);
      if (room.game.status === 'finished') this.#finishRace(room);
      else if (wasCurrent || !this.#anyHumanConnected(room)) this.#scheduleTurn(room);
    } else {
      room.seats = room.seats.filter((s) => s !== seat);
    }
    this.#touch(room);
    if (!room.seats.some((s) => s.kind === 'human' && !s.left)) {
      this.#closeRoom(room, 'empty');
      return;
    }
    this.#ensureHost(room);
    this.#updateEmptyRoomTimer(room);
    this.#broadcast(room);
  }

  /** Makes sure the host is a human who is still in the room. @param {Room} room */
  #ensureHost(room) {
    const host = room.seats.find((s) => s.playerId === room.hostId);
    if (host && host.kind === 'human' && !host.left) return;
    const humans = room.seats.filter((s) => s.kind === 'human' && !s.left);
    const next = humans.find((s) => s.connected) ?? humans[0];
    if (next) {
      room.hostId = next.playerId;
      this.#logger.info('host transferred', { room: room.code, host: next.playerId });
    }
  }

  /** @param {Room} room @param {Seat} seat */
  #startSeatGrace(room, seat) {
    this.#clearSeatGrace(seat);
    seat.graceTimer = this.#timer(() => {
      seat.graceTimer = null;
      if (seat.connected || !this.#rooms.has(room.code) || room.phase === 'playing') return;
      this.#logger.info('removing disconnected player', { room: room.code, player: seat.playerId });
      this.#removeSeat(room, seat);
    }, this.#options.lobbyGraceMs);
  }

  /** @param {Seat} seat */
  #clearSeatGrace(seat) {
    if (seat.graceTimer) this.#clock.clearTimeout(seat.graceTimer);
    seat.graceTimer = null;
  }

  /** Closes rooms nobody is connected to after a while. @param {Room} room */
  #updateEmptyRoomTimer(room) {
    const anyoneConnected = room.seats.some((s) => s.kind === 'human' && s.connected);
    if (anyoneConnected) {
      if (room.closeTimer) this.#clock.clearTimeout(room.closeTimer);
      room.closeTimer = null;
    } else if (!room.closeTimer) {
      room.closeTimer = this.#timer(() => {
        room.closeTimer = null;
        if (this.#rooms.get(room.code) === room) this.#closeRoom(room, 'abandoned');
      }, this.#options.emptyRoomTtlMs);
    }
  }

  /** @param {Room} room @param {string} reason */
  #closeRoom(room, reason) {
    this.#clearTurnTimer(room);
    if (room.closeTimer) this.#clock.clearTimeout(room.closeTimer);
    room.closeTimer = null;
    for (const seat of room.seats) {
      this.#clearSeatGrace(seat);
      if (!seat.connId) continue;
      const client = this.#clients.get(seat.connId);
      if (client && client.roomCode === room.code) {
        client.roomCode = null;
        client.playerId = null;
        this.#send(client.conn.id, { type: ServerMessage.LEFT, reason: 'room-closed' });
      }
    }
    this.#rooms.delete(room.code);
    this.#logger.info('room closed', { room: room.code, reason });
  }

  // ---------------------------------------------------------------------------
  // Helpers

  /** @param {() => void} fn @param {number} ms */
  #timer(fn, ms) {
    return this.#clock.setTimeout(() => {
      try {
        fn();
      } catch (err) {
        this.#logger.error('timer callback failed', { err: String(/** @type {any} */ (err)?.stack ?? err) });
      }
    }, ms);
  }

  /** @param {Room} room */
  #touch(room) {
    room.lastActivity = this.#clock.now();
  }

  #newRoomCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.#rooms.has(code)) return code;
    }
    throw fail(ErrorCode.SERVER_FULL, 'Could not allocate a room code.');
  }

  /** @param {Room} room @param {string} name */
  #uniqueName(room, name) {
    const taken = new Set(room.seats.map((s) => s.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const suffix = ` ${i}`;
      const candidate = Array.from(name).slice(0, MAX_NAME_LENGTH - suffix.length).join('') + suffix;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** @param {unknown} raw */
  #requireName(raw) {
    const name = sanitizeName(raw);
    if (!name) throw fail(ErrorCode.INVALID_NAME, 'Please enter a name.');
    return name;
  }

  /** @param {unknown} rawCode @returns {Room} */
  #requireRoom(rawCode) {
    const code = normalizeRoomCode(rawCode);
    if (!code) throw fail(ErrorCode.INVALID_ROOM_CODE, `Room codes are ${ROOM_CODE_LENGTH} letters/digits.`);
    const room = this.#rooms.get(code);
    if (!room) throw fail(ErrorCode.ROOM_NOT_FOUND, `Room ${code} does not exist (or has closed).`);
    return room;
  }

  /** @param {ClientState} client */
  #requireNoRoom(client) {
    if (client.roomCode && this.#rooms.has(client.roomCode)) {
      throw fail(ErrorCode.ALREADY_IN_ROOM, 'Leave your current room first.');
    }
    client.roomCode = null;
    client.playerId = null;
  }

  /** @param {ClientState} client @returns {{ room: Room, seat: Seat } | null} */
  #findSeat(client) {
    if (!client.roomCode) return null;
    const room = this.#rooms.get(client.roomCode);
    const seat = room?.seats.find((s) => s.playerId === client.playerId);
    return room && seat ? { room, seat } : null;
  }

  /** @param {ClientState} client */
  #requireSeat(client) {
    const found = this.#findSeat(client);
    if (!found || found.seat.left) throw fail(ErrorCode.NOT_IN_ROOM, 'You are not in a room.');
    return found;
  }

  /** @param {Room} room @param {Seat} seat */
  #requireHost(room, seat) {
    if (room.hostId !== seat.playerId) throw fail(ErrorCode.NOT_HOST, 'Only the host can do that.');
  }

  /** @param {Room} room */
  #requireNotPlaying(room) {
    if (room.phase === 'playing') throw fail(ErrorCode.GAME_IN_PROGRESS, 'Not possible while a race is running.');
  }

  /** @param {ClientState} client */
  #takeToken(client) {
    const now = this.#clock.now();
    const { rateLimitCapacity, rateLimitPerSecond, rateLimitMaxDropped, rateLimitWindowMs } = this.#options;
    client.tokens = Math.min(rateLimitCapacity, client.tokens + ((now - client.lastRefill) / 1000) * rateLimitPerSecond);
    client.lastRefill = now;
    if (client.tokens >= 1) {
      client.tokens -= 1;
      return true;
    }
    // Drops are counted per window (not reset by the odd accepted message), so a
    // sustained flood is disconnected even though some of it gets through.
    if (now - client.dropWindowStart > rateLimitWindowMs) {
      client.dropWindowStart = now;
      client.dropped = 0;
    }
    client.dropped += 1;
    if (client.dropped === 1) this.#sendError(client.conn.id, ErrorCode.RATE_LIMITED, 'Slow down! Too many messages.');
    if (client.dropped > rateLimitMaxDropped) {
      this.#logger.warn('closing flooding connection', { conn: client.conn.id });
      client.conn.close(CloseCode.POLICY_VIOLATION, 'Rate limit exceeded');
    }
    return false;
  }

  /** @param {Room} room */
  #view(room) {
    return {
      code: room.code,
      phase: room.phase,
      version: room.version,
      raceNumber: room.raceNumber,
      hostId: room.hostId,
      settings: room.settings,
      seats: room.seats.map((s, i) => ({
        playerId: s.playerId,
        name: s.name,
        kind: s.kind,
        botLevel: s.botLevel,
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        connected: s.kind === 'bot' || s.connected,
        autopilot: s.autopilot,
        left: s.left,
      })),
      game: room.game,
      turnDeadline: room.turnDeadline,
      waitingFor: room.waitingFor,
      serverTime: this.#clock.now(),
    };
  }

  /** Sends the room snapshot to everyone in it. @param {Room} room */
  #broadcast(room) {
    room.version += 1;
    const text = JSON.stringify({ type: ServerMessage.ROOM, room: this.#view(room) });
    for (const seat of room.seats) {
      if (seat.connId) this.#sendText(seat.connId, text);
    }
  }

  /** @param {ClientState} client @param {Room} room @param {Seat} seat */
  #sendJoined(client, room, seat) {
    this.#send(client.conn.id, { type: ServerMessage.JOINED, code: room.code, playerId: seat.playerId, token: seat.token });
  }

  /**
   * @param {string} connId @param {string} code @param {string} message
   * @param {string} [requestType] @param {Record<string, unknown>} [details]
   */
  #sendError(connId, code, message, requestType, details) {
    this.#send(connId, { type: ServerMessage.ERROR, code, message, requestType: requestType ?? null, details: details ?? null });
  }

  /** @param {string} connId @param {object} message */
  #send(connId, message) {
    this.#sendText(connId, JSON.stringify(message));
  }

  /** @param {string} connId @param {string} text */
  #sendText(connId, text) {
    const client = this.#clients.get(connId);
    if (!client) return;
    try {
      client.conn.send(text);
    } catch (err) {
      this.#logger.warn('send failed', { conn: connId, err: String(err) });
    }
  }
}

/** Constant-time token comparison. @param {string} expected @param {unknown} given */
function tokensEqual(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
