/**
 * Online multiplayer wire protocol (JSON over WebSocket), shared by server and client.
 * See docs/PROTOCOL.md for the full message reference.
 */

import { BOT_LEVELS, DEFAULT_FINISH_MODE, FINISH_MODES, MAX_LAPS } from './constants.js';
import { DEFAULT_TRACK_ID, hasTrack } from './tracks/index.js';

export const PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';

/** Largest accepted client message, in bytes. */
export const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_STRING_LENGTH = 256;

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
export const ROOM_CODE_LENGTH = 5;
export const MIN_ONLINE_PLAYERS = 2;

/** Allowed per-turn time limits in seconds (0 = unlimited). */
export const TURN_TIME_LIMITS = Object.freeze([0, 30, 60, 120]);

/**
 * @typedef {Object} RoomSettings
 * @property {string} trackId
 * @property {number} laps
 * @property {import('./constants.js').FinishMode} finishMode
 * @property {number} turnTimeLimit  seconds, one of TURN_TIME_LIMITS
 */

/** @type {Readonly<RoomSettings>} */
export const DEFAULT_ROOM_SETTINGS = Object.freeze({
  trackId: DEFAULT_TRACK_ID,
  laps: 1,
  finishMode: DEFAULT_FINISH_MODE,
  turnTimeLimit: 60,
});

export const ClientMessage = Object.freeze({
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  RESUME: 'resume',
  LEAVE_ROOM: 'leave_room',
  ADD_BOT: 'add_bot',
  REMOVE_PLAYER: 'remove_player',
  UPDATE_SETTINGS: 'update_settings',
  START_GAME: 'start_game',
  MOVE: 'move',
  PING: 'ping',
});

export const ServerMessage = Object.freeze({
  WELCOME: 'welcome',
  JOINED: 'joined',
  ROOM: 'room',
  LEFT: 'left',
  ERROR: 'error',
  PONG: 'pong',
});

export const ErrorCode = Object.freeze({
  BAD_MESSAGE: 'BAD_MESSAGE',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_FULL: 'SERVER_FULL',
  TOO_MANY_ROOMS: 'TOO_MANY_ROOMS',
  INVALID_NAME: 'INVALID_NAME',
  INVALID_SETTINGS: 'INVALID_SETTINGS',
  INVALID_ROOM_CODE: 'INVALID_ROOM_CODE',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  GAME_IN_PROGRESS: 'GAME_IN_PROGRESS',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
  INVALID_SESSION: 'INVALID_SESSION',
  SESSION_REPLACED: 'SESSION_REPLACED',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  GAME_NOT_RUNNING: 'GAME_NOT_RUNNING',
  STALE_TURN: 'STALE_TURN',
  UNKNOWN_PLAYER: 'UNKNOWN_PLAYER',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_ACCELERATION: 'INVALID_ACCELERATION',
  GAME_OVER: 'GAME_OVER',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/** WebSocket close codes used by the server (4000-4999 is the application range). */
export const CloseCode = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  TRY_AGAIN_LATER: 1013,
  SESSION_REPLACED: 4000,
  PROTOCOL_MISMATCH: 4001,
});

/**
 * Field schemas for client messages. A trailing "?" marks optional fields.
 * @type {Record<string, Record<string, string>>}
 */
const CLIENT_SCHEMAS = {
  [ClientMessage.CREATE_ROOM]: { name: 'string', settings: 'object?' },
  [ClientMessage.JOIN_ROOM]: { code: 'string', name: 'string' },
  [ClientMessage.RESUME]: { code: 'string', playerId: 'string', token: 'string' },
  [ClientMessage.LEAVE_ROOM]: {},
  [ClientMessage.ADD_BOT]: { level: 'string' },
  [ClientMessage.REMOVE_PLAYER]: { playerId: 'string' },
  [ClientMessage.UPDATE_SETTINGS]: { settings: 'object' },
  [ClientMessage.START_GAME]: {},
  [ClientMessage.MOVE]: { turn: 'integer', acceleration: 'object' },
  [ClientMessage.PING]: {},
};

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} value @param {string} type */
function matchesType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string' && value.length <= MAX_STRING_LENGTH;
    case 'integer':
      return Number.isSafeInteger(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

/**
 * @typedef {{ ok: true, message: Record<string, any> & { type: string } }} ParseSuccess
 * @typedef {{ ok: false, code: string, error: string }} ParseFailure
 */

/**
 * Parses and validates a raw client message. Unknown extra fields are dropped.
 * @param {unknown} raw  text frame contents
 * @returns {ParseSuccess | ParseFailure}
 */
export function parseClientMessage(raw) {
  if (typeof raw !== 'string') return { ok: false, code: ErrorCode.BAD_MESSAGE, error: 'Messages must be text.' };
  if (raw.length > MAX_MESSAGE_BYTES) {
    return { ok: false, code: ErrorCode.BAD_MESSAGE, error: 'Message too large.' };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: ErrorCode.BAD_MESSAGE, error: 'Message is not valid JSON.' };
  }
  if (!isPlainObject(data) || typeof data.type !== 'string') {
    return { ok: false, code: ErrorCode.BAD_MESSAGE, error: 'Message must be an object with a "type".' };
  }
  const schema = Object.hasOwn(CLIENT_SCHEMAS, data.type) ? CLIENT_SCHEMAS[data.type] : undefined;
  if (!schema) {
    return { ok: false, code: ErrorCode.UNKNOWN_TYPE, error: `Unknown message type "${String(data.type).slice(0, 40)}".` };
  }
  /** @type {Record<string, any> & { type: string }} */
  const message = { type: data.type };
  for (const [field, spec] of Object.entries(schema)) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    const value = data[field];
    if (value === undefined && optional) continue;
    if (!matchesType(value, type)) {
      return { ok: false, code: ErrorCode.BAD_MESSAGE, error: `Field "${field}" of "${data.type}" must be a valid ${type}.` };
    }
    message[field] = value;
  }
  return { ok: true, message };
}

/**
 * Normalises user-typed room codes ("abc d2" -> "ABCD2"); null if malformed.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * Validates (partial) room settings on top of `base`.
 * @param {unknown} raw
 * @param {RoomSettings} [base]
 * @returns {{ ok: true, settings: RoomSettings } | { ok: false, error: string }}
 */
export function validateRoomSettings(raw, base = DEFAULT_ROOM_SETTINGS) {
  if (raw === undefined || raw === null) return { ok: true, settings: { ...base } };
  if (!isPlainObject(raw)) return { ok: false, error: 'Settings must be an object.' };
  const s = /** @type {Record<string, unknown>} */ (raw);
  const settings = { ...base };
  if (s.trackId !== undefined) {
    if (!hasTrack(s.trackId)) return { ok: false, error: 'Unknown track.' };
    settings.trackId = /** @type {string} */ (s.trackId);
  }
  if (s.laps !== undefined) {
    if (!Number.isInteger(s.laps) || /** @type {number} */ (s.laps) < 1 || /** @type {number} */ (s.laps) > MAX_LAPS) {
      return { ok: false, error: `Laps must be between 1 and ${MAX_LAPS}.` };
    }
    settings.laps = /** @type {number} */ (s.laps);
  }
  if (s.finishMode !== undefined) {
    if (!FINISH_MODES.includes(/** @type {any} */ (s.finishMode))) {
      return { ok: false, error: `Finish mode must be one of ${FINISH_MODES.join(', ')}.` };
    }
    settings.finishMode = /** @type {import('./constants.js').FinishMode} */ (s.finishMode);
  }
  if (s.turnTimeLimit !== undefined) {
    if (!TURN_TIME_LIMITS.includes(/** @type {number} */ (s.turnTimeLimit))) {
      return { ok: false, error: `Turn time limit must be one of ${TURN_TIME_LIMITS.join(', ')} seconds.` };
    }
    settings.turnTimeLimit = /** @type {number} */ (s.turnTimeLimit);
  }
  return { ok: true, settings };
}

/** @param {unknown} level @returns {level is import('./constants.js').BotLevel} */
export function isBotLevel(level) {
  return typeof level === 'string' && /** @type {readonly string[]} */ (BOT_LEVELS).includes(level);
}

/**
 * Light validation of messages received by the client.
 * @param {unknown} raw
 * @returns {{ ok: true, message: Record<string, any> & { type: string } } | { ok: false, error: string }}
 */
export function parseServerMessage(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Expected a text message.' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Server sent invalid JSON.' };
  }
  if (!isPlainObject(data) || typeof data.type !== 'string') return { ok: false, error: 'Server message has no type.' };
  if (!Object.values(ServerMessage).includes(data.type)) return { ok: false, error: `Unknown server message "${data.type}".` };
  return { ok: true, message: data };
}
