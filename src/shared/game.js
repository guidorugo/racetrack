/**
 * The Racetrack rules engine.
 *
 * Pure functions over plain, JSON-serialisable state objects: nothing here touches
 * the DOM, the network or the clock, so the exact same code runs in the browser
 * (single-player and local games), on the server (online games) and in tests.
 * State is never mutated; every transition returns a new state object.
 *
 * Rules implemented:
 *  - Movement: new velocity = velocity + acceleration (each axis -1, 0 or +1);
 *    new position = position + new velocity. That gives nine candidate points:
 *    the point one velocity vector away and its eight neighbours.
 *  - Crash: if the straight path touches a wall or leaves the track, or the
 *    destination is occupied by another car, the move is a crash. The turn ends,
 *    the car stays where it was and its velocity drops to zero.
 *  - Finish: a legal move that crosses the finish line in the racing direction
 *    and completes the required number of laps wins, and the game ends at once.
 *  - Turn order is fixed (seat order); retired cars are skipped.
 *  - Safety net: if `maxRounds` rounds pass without a winner the game ends as a draw.
 *
 * @typedef {import('./vec.js').Vec} Vec
 * @typedef {import('./track.js').Track} Track
 * @typedef {import('./constants.js').BotLevel} BotLevel
 *
 * @typedef {'human' | 'bot'} PlayerKind
 * @typedef {'racing' | 'finished' | 'retired'} CarStatus
 *
 * @typedef {Object} PlayerConfig
 * @property {string} id
 * @property {string} name
 * @property {PlayerKind} [kind]      Defaults to 'human'.
 * @property {BotLevel} [botLevel]    Only for bots; defaults to 'medium'.
 * @property {string} [color]         #rrggbb; defaults to the seat colour.
 *
 * @typedef {Object} PlayerState
 * @property {string} id
 * @property {string} name
 * @property {PlayerKind} kind
 * @property {BotLevel | null} botLevel
 * @property {string} color
 * @property {Vec} startPosition
 * @property {Vec} position
 * @property {Vec} velocity
 * @property {number} crashes
 * @property {number} lapProgress     Net forward crossings of the finish line.
 * @property {number} moves           Turns taken (crashes included).
 * @property {CarStatus} status
 *
 * @typedef {'moved' | 'crashed' | 'won'} MoveOutcome
 * @typedef {'wall' | 'car'} CrashReason
 *
 * @typedef {Object} MoveRecord
 * @property {number} turn            1-based sequence number of the move.
 * @property {number} round
 * @property {string} playerId
 * @property {Vec} acceleration
 * @property {Vec} from               Position before the move.
 * @property {Vec} target             Grid point the car tried to reach.
 * @property {Vec} to                 Position after the move (equals `from` on a crash).
 * @property {Vec} velocity           Velocity after the move (zero on a crash).
 * @property {MoveOutcome} outcome
 * @property {CrashReason | null} crash
 * @property {-1 | 0 | 1} lapDelta
 * @property {string | null} note     Optional annotation, e.g. 'timeout' for server auto-moves.
 *
 * @typedef {'win' | 'round-limit' | 'all-retired'} EndReason
 *
 * @typedef {Object} GameState
 * @property {number} schema
 * @property {string} trackId
 * @property {number} laps
 * @property {number} maxRounds
 * @property {'playing' | 'finished'} status
 * @property {EndReason | null} endReason
 * @property {string | null} winnerId
 * @property {number} turn            Number of moves applied so far.
 * @property {number} round           1-based; increments when play wraps to the first seat.
 * @property {number} currentPlayerIndex
 * @property {PlayerState[]} players
 * @property {MoveRecord[]} history
 *
 * @typedef {Object} MoveOption
 * @property {number} index           Index into ACCELERATIONS (numpad order).
 * @property {Vec} acceleration
 * @property {Vec} velocity           Velocity the car would have after the move.
 * @property {Vec} target             Destination grid point.
 * @property {'move' | 'crash' | 'win'} outcome
 * @property {CrashReason | null} crash
 * @property {string | null} blockedBy  Id of the car occupying the target, if any.
 * @property {-1 | 0 | 1} lapDelta
 */

import {
  ACCELERATIONS,
  BOT_LEVELS,
  DEFAULT_LAPS,
  DEFAULT_MAX_ROUNDS,
  MAX_LAPS,
  MAX_PLAYERS,
  MAX_ROUNDS_LIMIT,
  MIN_PLAYERS,
  PLAYER_COLORS,
} from './constants.js';
import { EngineErrors, GameError } from './errors.js';
import { isHexColor, sanitizeName } from './validation.js';

export const GAME_SCHEMA_VERSION = 1;

/**
 * Creates a new game with every car on its start position, stationary.
 * @param {{ players: PlayerConfig[], laps?: number, maxRounds?: number }} config
 * @param {Track} track
 * @returns {GameState}
 */
export function createGame(config, track) {
  const invalid = (/** @type {string} */ message) => new GameError(EngineErrors.INVALID_CONFIG, message);
  if (!config || typeof config !== 'object') throw invalid('Game configuration is required.');
  if (!track || !Array.isArray(track.startPositions)) throw invalid('A valid track is required.');

  const { players, laps = DEFAULT_LAPS, maxRounds = DEFAULT_MAX_ROUNDS } = config;
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw invalid(`A game needs between ${MIN_PLAYERS} and ${MAX_PLAYERS} players.`);
  }
  if (players.length > track.startPositions.length) {
    throw invalid(`Track "${track.id}" only has ${track.startPositions.length} start positions.`);
  }
  if (!Number.isInteger(laps) || laps < 1 || laps > MAX_LAPS) {
    throw invalid(`Laps must be an integer between 1 and ${MAX_LAPS}.`);
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS_LIMIT) {
    throw invalid(`maxRounds must be an integer between 1 and ${MAX_ROUNDS_LIMIT}.`);
  }

  const ids = new Set();
  const playerStates = players.map((p, i) => {
    if (!p || typeof p !== 'object') throw invalid(`Player ${i + 1} is not a valid player.`);
    if (typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 64) {
      throw invalid(`Player ${i + 1} needs a string id.`);
    }
    if (ids.has(p.id)) throw invalid(`Duplicate player id "${p.id}".`);
    ids.add(p.id);
    const name = sanitizeName(p.name);
    if (!name) throw invalid(`Player ${i + 1} needs a name.`);
    const kind = p.kind ?? 'human';
    if (kind !== 'human' && kind !== 'bot') throw invalid(`Player ${i + 1} has an unknown kind "${kind}".`);
    let botLevel = null;
    if (kind === 'bot') {
      botLevel = p.botLevel ?? 'medium';
      if (!BOT_LEVELS.includes(botLevel)) throw invalid(`Player ${i + 1} has an unknown bot level "${botLevel}".`);
    }
    const color = p.color === undefined ? PLAYER_COLORS[i % PLAYER_COLORS.length] : p.color;
    if (!isHexColor(color)) throw invalid(`Player ${i + 1} has an invalid colour.`);
    const start = track.startPositions[i];
    return {
      id: p.id,
      name,
      kind,
      botLevel,
      color,
      startPosition: { x: start.x, y: start.y },
      position: { x: start.x, y: start.y },
      velocity: { x: 0, y: 0 },
      crashes: 0,
      lapProgress: 0,
      moves: 0,
      /** @type {CarStatus} */ status: 'racing',
    };
  });

  return {
    schema: GAME_SCHEMA_VERSION,
    trackId: track.id,
    laps,
    maxRounds,
    status: 'playing',
    endReason: null,
    winnerId: null,
    turn: 0,
    round: 1,
    currentPlayerIndex: 0,
    players: playerStates,
    history: [],
  };
}

/**
 * The player whose turn it is, or null once the game is over.
 * @param {GameState} state
 * @returns {PlayerState | null}
 */
export function getCurrentPlayer(state) {
  if (state.status !== 'playing') return null;
  return state.players[state.currentPlayerIndex] ?? null;
}

/**
 * Validates an acceleration coming from untrusted input and returns a clean copy.
 * @param {unknown} acceleration
 * @returns {Vec}
 */
export function validateAcceleration(acceleration) {
  const a = /** @type {any} */ (acceleration);
  if (
    !a ||
    typeof a !== 'object' ||
    !Number.isInteger(a.x) ||
    !Number.isInteger(a.y) ||
    Math.abs(a.x) > 1 ||
    Math.abs(a.y) > 1
  ) {
    throw new GameError(
      EngineErrors.INVALID_ACCELERATION,
      'Acceleration must have integer x and y components between -1 and 1.',
    );
  }
  return { x: a.x + 0, y: a.y + 0 }; // "+ 0" normalises -0
}

/**
 * Works out what would happen if the given player applied `acceleration` now.
 * Does not check whose turn it is.
 * @param {GameState} state
 * @param {Track} track
 * @param {number} playerIndex
 * @param {Vec} acceleration  must already be valid
 * @returns {MoveOption}
 */
export function evaluateMove(state, track, playerIndex, acceleration) {
  const player = state.players[playerIndex];
  if (!player) throw new GameError(EngineErrors.UNKNOWN_PLAYER, `No player at seat ${playerIndex}.`);
  const velocity = { x: player.velocity.x + acceleration.x, y: player.velocity.y + acceleration.y };
  const target = { x: player.position.x + velocity.x, y: player.position.y + velocity.y };
  const index = (acceleration.y + 1) * 3 + (acceleration.x + 1);
  const base = { index, acceleration: { x: acceleration.x, y: acceleration.y }, velocity, target };

  if (track.moveHitsWall(player.position, target)) {
    return { ...base, outcome: 'crash', crash: 'wall', blockedBy: null, lapDelta: 0 };
  }
  const blocker = state.players.find(
    (other, i) =>
      i !== playerIndex &&
      other.status !== 'retired' &&
      other.position.x === target.x &&
      other.position.y === target.y,
  );
  if (blocker) {
    return { ...base, outcome: 'crash', crash: 'car', blockedBy: blocker.id, lapDelta: 0 };
  }
  const lapDelta = track.finishCrossing(player.position, target);
  const wins = lapDelta > 0 && player.lapProgress + lapDelta >= state.laps;
  return { ...base, outcome: wins ? 'win' : 'move', crash: null, blockedBy: null, lapDelta };
}

/**
 * The nine options (numpad order) for the player whose turn it is.
 * Returns an empty list when the game is over.
 * @param {GameState} state
 * @param {Track} track
 * @returns {MoveOption[]}
 */
export function getMoveOptions(state, track) {
  if (state.status !== 'playing') return [];
  return ACCELERATIONS.map((a) => evaluateMove(state, track, state.currentPlayerIndex, a));
}

/**
 * Applies the current player's move and advances the game.
 * @param {GameState} state
 * @param {Track} track
 * @param {unknown} acceleration  untrusted; validated here
 * @param {{ playerId?: string, note?: string | null }} [options]
 *   `playerId` — when given, the move is rejected unless it is that player's turn.
 *   `note` — optional annotation stored on the move record.
 * @returns {{ state: GameState, move: MoveRecord }}
 */
export function applyMove(state, track, acceleration, options = {}) {
  if (state.status !== 'playing') {
    throw new GameError(EngineErrors.GAME_OVER, 'The game is already over.');
  }
  if (track.id !== state.trackId) {
    throw new GameError(EngineErrors.UNKNOWN_TRACK, `This game is played on "${state.trackId}", not "${track.id}".`);
  }
  const acc = validateAcceleration(acceleration);
  const index = state.currentPlayerIndex;
  const current = state.players[index];
  if (options.playerId !== undefined && options.playerId !== current.id) {
    throw new GameError(EngineErrors.NOT_YOUR_TURN, `It is ${current.name}'s turn.`, {
      currentPlayerId: current.id,
    });
  }

  const option = evaluateMove(state, track, index, acc);
  const next = copyForUpdate(state);
  const player = next.players[index];
  const from = { x: player.position.x, y: player.position.y };

  /** @type {MoveOutcome} */
  let outcome;
  if (option.outcome === 'crash') {
    player.velocity = { x: 0, y: 0 };
    player.crashes += 1;
    outcome = 'crashed';
  } else {
    player.position = { x: option.target.x, y: option.target.y };
    player.velocity = { x: option.velocity.x, y: option.velocity.y };
    player.lapProgress += option.lapDelta;
    outcome = option.outcome === 'win' ? 'won' : 'moved';
  }
  player.moves += 1;

  /** @type {MoveRecord} */
  const move = {
    turn: state.turn + 1,
    round: state.round,
    playerId: player.id,
    acceleration: acc,
    from,
    target: { x: option.target.x, y: option.target.y },
    to: { x: player.position.x, y: player.position.y },
    velocity: { x: player.velocity.x, y: player.velocity.y },
    outcome,
    crash: option.crash,
    lapDelta: outcome === 'crashed' ? 0 : option.lapDelta,
    note: typeof options.note === 'string' ? options.note : null,
  };
  next.history = [...state.history, move];
  next.turn = move.turn;

  if (outcome === 'won') {
    player.status = 'finished';
    next.status = 'finished';
    next.endReason = 'win';
    next.winnerId = player.id;
  } else {
    advanceTurn(next);
  }
  return { state: next, move };
}

/**
 * Removes a car from the race (e.g. its player left an online game). Its turns
 * are skipped from now on and it no longer blocks other cars. If it was that
 * player's turn, play passes to the next racing car.
 * @param {GameState} state
 * @param {string} playerId
 * @returns {GameState}
 */
export function retirePlayer(state, playerId) {
  const index = state.players.findIndex((p) => p.id === playerId);
  if (index === -1) throw new GameError(EngineErrors.UNKNOWN_PLAYER, `Unknown player "${playerId}".`);
  if (state.status !== 'playing' || state.players[index].status !== 'racing') return state;
  const next = copyForUpdate(state);
  next.players[index].status = 'retired';
  if (!next.players.some((p) => p.status === 'racing')) {
    next.status = 'finished';
    next.endReason = 'all-retired';
  } else if (index === next.currentPlayerIndex) {
    advanceTurn(next);
  }
  return next;
}

/**
 * A copy of `state` whose top level and player objects may be modified freely.
 * Everything below them is shared: move records, positions and velocities are
 * never mutated in place (they are replaced), so sharing is safe and keeps each
 * move cheap even late in a long race.
 * @param {GameState} state
 * @returns {GameState}
 */
function copyForUpdate(state) {
  return { ...state, players: state.players.map((p) => ({ ...p })) };
}

/**
 * Moves play to the next racing car (mutates the given, already-copied state).
 * @param {GameState} state
 */
function advanceTurn(state) {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const candidate = (state.currentPlayerIndex + step) % n;
    if (state.players[candidate].status !== 'racing') continue;
    if (state.currentPlayerIndex + step >= n) state.round += 1;
    state.currentPlayerIndex = candidate;
    if (state.round > state.maxRounds) {
      state.status = 'finished';
      state.endReason = 'round-limit';
      state.winnerId = null;
    }
    return;
  }
  state.status = 'finished';
  state.endReason = 'all-retired';
}

/**
 * Positions a car has occupied, in order, starting from its start position.
 * Crashes do not move the car, so they add no points.
 * @param {GameState} state
 * @param {string} playerId
 * @returns {Vec[]}
 */
export function getTrail(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return [];
  const trail = [player.startPosition];
  for (const m of state.history) {
    if (m.playerId === playerId && m.outcome !== 'crashed') trail.push(m.to);
  }
  return trail;
}

/**
 * Structural sanity check for game states received from elsewhere (e.g. the
 * network). It guards the renderer against malformed data; it is not a full
 * replay validation.
 * @param {unknown} value
 * @returns {value is GameState}
 */
export function isGameStateShape(value) {
  const s = /** @type {any} */ (value);
  if (!s || typeof s !== 'object') return false;
  if (typeof s.trackId !== 'string' || !Array.isArray(s.players) || !Array.isArray(s.history)) return false;
  if (s.status !== 'playing' && s.status !== 'finished') return false;
  if (!Number.isInteger(s.turn) || !Number.isInteger(s.round) || !Number.isInteger(s.currentPlayerIndex)) return false;
  if (s.players.length < 1 || s.players.length > MAX_PLAYERS) return false;
  if (s.currentPlayerIndex < 0 || s.currentPlayerIndex >= s.players.length) return false;
  const vecOk = (/** @type {any} */ v) => v && Number.isInteger(v.x) && Number.isInteger(v.y);
  return s.players.every(
    (/** @type {any} */ p) =>
      p &&
      typeof p.id === 'string' &&
      typeof p.name === 'string' &&
      vecOk(p.position) &&
      vecOk(p.velocity) &&
      vecOk(p.startPosition),
  );
}
