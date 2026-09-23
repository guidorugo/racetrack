/**
 * Bot AI: picks one of the nine moves for the car whose turn it is.
 *
 * Algorithm (receding-horizon search):
 *  1. A distance field (see distanceField.js) gives, for every grid point, the
 *     length of the shortest path to the finish, going the right way round.
 *  2. For each of the nine moves, the bot searches every crash-free sequence of
 *     follow-up moves up to its horizon (difficulty-dependent) and scores the
 *     sequence by the distance still to go at its end — i.e. it favours the move
 *     that allows the most progress over the next few turns.
 *  3. Plans must end in a *safe* state: one from which the car can brake to a
 *     standstill without touching a wall (`canStop`). This stops the bot from
 *     carrying too much speed into a bend beyond its horizon.
 *  4. Moves that finish the race win outright; moves that crash (wall or another
 *     car's position) are only chosen if every option crashes.
 *
 * Other cars block the immediate move exactly (landing on one is a crash). For
 * the move after that, the bot also steers clear of the cells other cars occupy
 * now or will reach if they keep their speed, so it doesn't plan its escape route
 * through a square a rival is likely to be sitting on. Beyond that other cars are
 * ignored. Easy bots add noise and occasional blunders.
 *
 * @typedef {import('./track.js').Track} Track
 * @typedef {import('./game.js').GameState} GameState
 * @typedef {import('./vec.js').Vec} Vec
 * @typedef {import('./constants.js').BotLevel} BotLevel
 * @typedef {import('./distanceField.js').DistanceField} DistanceField
 */

import { ACCELERATIONS, BOT_LEVELS } from './constants.js';
import { distanceAt, getDistanceField } from './distanceField.js';
import { EngineErrors, GameError } from './errors.js';
import { evaluateMove, getCurrentPlayer } from './game.js';

/**
 * Tuning per difficulty.
 * @typedef {Object} BotProfile
 * @property {number} depth          How many turns ahead the bot plans (1-8).
 * @property {number} noise          Random jitter (grid units of progress) added to each move's score.
 * @property {number} blunderChance  Probability of picking a random non-crashing move instead.
 * @property {number} fragility      Penalty for plans ending where only one move keeps the car safe
 *                                   (another car on that one square would force a crash).
 * @property {boolean} avoidTraffic  Keep the second move of a plan off squares rivals occupy or head to.
 */

/** @type {Readonly<Record<BotLevel, Readonly<BotProfile>>>} */
export const BOT_PROFILES = Object.freeze({
  // Measured on the oval, where the fastest possible solo lap is 27 turns (28
  // without a deliberate crash to kill speed): easy ≈ 36 turns with the odd
  // crash, medium ≈ 31, hard ≈ 29. Bots never crash on purpose.
  easy: Object.freeze({ depth: 2, noise: 5, blunderChance: 0.15, fragility: 0, avoidTraffic: false }),
  medium: Object.freeze({ depth: 2, noise: 3, blunderChance: 0, fragility: 8, avoidTraffic: true }),
  hard: Object.freeze({ depth: 6, noise: 0, blunderChance: 0, fragility: 0, avoidTraffic: true }),
});

// Score scale (lower is better). Real race distances are far below 1e5.
const WIN = -1e9; // + ply, so earlier wins are preferred
const UNSAFE = 1e6; // plan ends at a speed the car cannot brake from in time
const DEAD_END = 1e8; // every continuation crashes
const CRASH_NOW = 1e9; // the move itself crashes
/** How much the progress the car would make by coasting one more turn counts. */
const MOMENTUM_WEIGHT = 0.5;
/** Tie-breaker: prefer moves that also make immediate progress. */
const IMMEDIATE_WEIGHT = 1e-3;

/** Per-track caches shared by all bots (wall checks and braking analysis never change). */
class TrackBrain {
  /** @param {Track} track */
  constructor(track) {
    this.track = track;
    this.field = getDistanceField(track);
    /** @type {Map<number, boolean>} */
    this.wallCache = new Map();
    /** @type {Map<number, boolean>} */
    this.stopCache = new Map();
  }

  /** Cached `track.moveHitsWallXY`. */
  hitsWall(/** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ x1, /** @type {number} */ y1) {
    if (x1 < -256 || y1 < -256 || x1 > 767 || y1 > 767) return true; // far off the grid
    const key = (((x0 + 256) * 1024 + (y0 + 256)) * 1024 + (x1 + 256)) * 1024 + (y1 + 256);
    let hit = this.wallCache.get(key);
    if (hit === undefined) {
      hit = this.track.moveHitsWallXY(x0, y0, x1, y1);
      if (this.wallCache.size >= 400_000) this.wallCache.clear();
      this.wallCache.set(key, hit);
    }
    return hit;
  }

  /**
   * Whether a car at (x, y) with velocity (vx, vy) can come to a complete stop,
   * braking as hard as possible every turn (steering allowed), without crashing.
   */
  canStop(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ vx, /** @type {number} */ vy) {
    if (vx === 0 && vy === 0) return true;
    if (Math.abs(vx) >= 64 || Math.abs(vy) >= 64) return false;
    const key = ((x * 1024 + y) * 128 + (vx + 64)) * 128 + (vy + 64);
    const cached = this.stopCache.get(key);
    if (cached !== undefined) return cached;
    const speed = Math.max(Math.abs(vx), Math.abs(vy));
    let ok = false;
    for (const a of ACCELERATIONS) {
      const nvx = vx + a.x;
      const nvy = vy + a.y;
      if (Math.max(Math.abs(nvx), Math.abs(nvy)) >= speed) continue;
      const nx = x + nvx;
      const ny = y + nvy;
      if (this.hitsWall(x, y, nx, ny)) continue;
      if (this.canStop(nx, ny, nvx, nvy)) {
        ok = true;
        break;
      }
    }
    if (this.stopCache.size >= 400_000) this.stopCache.clear();
    this.stopCache.set(key, ok);
    return ok;
  }

  /**
   * How many of the nine next moves keep the car safe (no wall, can still stop),
   * counting only up to `limit`.
   */
  safeContinuations(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ vx, /** @type {number} */ vy, /** @type {number} */ limit) {
    let count = 0;
    for (const a of ACCELERATIONS) {
      const nvx = vx + a.x;
      const nvy = vy + a.y;
      const nx = x + nvx;
      const ny = y + nvy;
      if (this.hitsWall(x, y, nx, ny) || !this.canStop(nx, ny, nvx, nvy)) continue;
      if (++count >= limit) break;
    }
    return count;
  }
}

/** @type {WeakMap<Track, TrackBrain>} */
const brains = new WeakMap();

/** @param {Track} track */
function brainFor(track) {
  let brain = brains.get(track);
  if (!brain) {
    brain = new TrackBrain(track);
    brains.set(track, brain);
  }
  return brain;
}

/**
 * Search context for one decision.
 * @typedef {Object} SearchContext
 * @property {TrackBrain} brain
 * @property {number} laps
 * @property {number} depth
 * @property {Map<number, number>} memo
 * @property {Set<number>} blocked  Cells to avoid for the second move of a plan.
 * @property {number} fragility
 */

/** @param {number} x @param {number} y */
const cellKey = (x, y) => (x + 1024) * 4096 + (y + 1024);

/**
 * Remaining race distance from (x, y) with the given lap progress.
 * @param {SearchContext} ctx @param {number} x @param {number} y @param {number} lap
 */
function remaining(ctx, x, y, lap) {
  const d = distanceAt(ctx.brain.field, x, y);
  return d + Math.max(0, ctx.laps - lap - 1) * ctx.brain.field.lapLength;
}

/**
 * Score of a plan that ends in state (x, y, vx, vy, lap).
 * @param {SearchContext} ctx
 */
function leafScore(ctx, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ vx, /** @type {number} */ vy, /** @type {number} */ lap) {
  const { brain } = ctx;
  const here = remaining(ctx, x, y, lap);
  if (here === Infinity) return DEAD_END;
  // Momentum bonus: how much closer one more turn of coasting would bring us.
  let momentum = 0;
  const cx = x + vx;
  const cy = y + vy;
  if ((vx !== 0 || vy !== 0) && !brain.hitsWall(x, y, cx, cy)) {
    const delta = brain.track.finishCrossingXY(x, y, cx, cy);
    const coastLap = lap + delta;
    const there = delta > 0 && coastLap >= ctx.laps ? 0 : remaining(ctx, cx, cy, coastLap);
    if (there !== Infinity) momentum = here - there;
  }
  const score = here - MOMENTUM_WEIGHT * momentum;
  if (!brain.canStop(x, y, vx, vy)) return score + UNSAFE;
  return ctx.fragility > 0 && brain.safeContinuations(x, y, vx, vy, 2) < 2 ? score + ctx.fragility : score;
}

/**
 * Best (lowest) score reachable from the given state when the next move is move
 * number `ply` of the plan.
 * @param {SearchContext} ctx
 */
function bestScore(ctx, /** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ vx, /** @type {number} */ vy, /** @type {number} */ lap, /** @type {number} */ ply) {
  const memoable = Math.abs(vx) < 64 && Math.abs(vy) < 64 && lap > -128 && lap < 128;
  const key = memoable ? ((((x * 1024 + y) * 128 + (vx + 64)) * 128 + (vy + 64)) * 256 + (lap + 128)) * 16 + ply : -1;
  if (memoable) {
    const cached = ctx.memo.get(key);
    if (cached !== undefined) return cached;
  }
  const { brain } = ctx;
  let best = DEAD_END;
  for (const a of ACCELERATIONS) {
    const nvx = vx + a.x;
    const nvy = vy + a.y;
    const nx = x + nvx;
    const ny = y + nvy;
    if (brain.hitsWall(x, y, nx, ny)) continue;
    if (ply === 2 && ctx.blocked.has(cellKey(nx, ny))) continue;
    const delta = brain.track.finishCrossingXY(x, y, nx, ny);
    const nlap = lap + delta;
    let score;
    if (delta > 0 && nlap >= ctx.laps) score = WIN + ply;
    else if (ply >= ctx.depth) score = leafScore(ctx, nx, ny, nvx, nvy, nlap);
    else score = bestScore(ctx, nx, ny, nvx, nvy, nlap, ply + 1);
    if (score < best) best = score;
  }
  if (memoable) ctx.memo.set(key, best);
  return best;
}

/**
 * @typedef {Object} RankedMove
 * @property {number} index         Index into ACCELERATIONS.
 * @property {Vec} acceleration
 * @property {number} score         Lower is better.
 * @property {'move' | 'crash' | 'win'} outcome
 */

/**
 * Scores all nine moves for the current player (deterministic, no noise).
 * @param {GameState} state
 * @param {Track} track
 * @param {{ depth?: number, fragility?: number, avoidTraffic?: boolean }} [options]
 * @returns {RankedMove[]}
 */
export function rankMoves(state, track, options = {}) {
  const player = getCurrentPlayer(state);
  if (!player) throw new GameError(EngineErrors.GAME_OVER, 'The game is already over.');
  const depth = Math.max(1, Math.min(8, options.depth ?? BOT_PROFILES.medium.depth));
  const fragility = options.fragility ?? BOT_PROFILES.medium.fragility;
  const avoidTraffic = options.avoidTraffic ?? BOT_PROFILES.medium.avoidTraffic;
  /** @type {Set<number>} */
  const blocked = new Set();
  state.players.forEach((other, i) => {
    if (!avoidTraffic || i === state.currentPlayerIndex || other.status === 'retired') return;
    const { position: p, velocity: v } = other;
    blocked.add(cellKey(p.x, p.y));
    blocked.add(cellKey(p.x + v.x, p.y + v.y));
  });
  /** @type {SearchContext} */
  const ctx = { brain: brainFor(track), laps: state.laps, depth, memo: new Map(), blocked, fragility };

  return ACCELERATIONS.map((a, index) => {
    const option = evaluateMove(state, track, state.currentPlayerIndex, a);
    const acceleration = { x: a.x, y: a.y };
    if (option.outcome === 'crash') return { index, acceleration, score: CRASH_NOW, outcome: option.outcome };
    if (option.outcome === 'win') return { index, acceleration, score: WIN, outcome: option.outcome };
    const { target: t, velocity: v } = option;
    const lap = player.lapProgress + option.lapDelta;
    const future = depth === 1 ? leafScore(ctx, t.x, t.y, v.x, v.y, lap) : bestScore(ctx, t.x, t.y, v.x, v.y, lap, 2);
    const immediate = remaining(ctx, t.x, t.y, lap);
    const score = future + IMMEDIATE_WEIGHT * (immediate === Infinity ? 1e6 : immediate);
    return { index, acceleration, score, outcome: option.outcome };
  });
}

/**
 * Chooses the bot's move for the player whose turn it is.
 * @param {GameState} state
 * @param {Track} track
 * @param {{ level?: BotLevel, rng?: () => number, profile?: Partial<BotProfile> }} [options]
 *   `rng` must return floats in [0, 1); pass a seeded generator for reproducibility.
 *   `profile` overrides individual tuning values of the level's profile.
 * @returns {Vec} the chosen acceleration
 */
export function chooseBotMove(state, track, options = {}) {
  const level = options.level ?? 'medium';
  if (!BOT_LEVELS.includes(level)) throw new GameError(EngineErrors.INVALID_CONFIG, `Unknown bot level "${level}".`);
  const rng = options.rng ?? Math.random;
  /** @type {BotProfile} */
  const profile = { ...BOT_PROFILES[level], ...options.profile };
  const ranked = rankMoves(state, track, profile);

  const win = ranked.find((m) => m.outcome === 'win');
  if (win) return win.acceleration;

  const viable = ranked.filter((m) => m.outcome !== 'crash');
  if (viable.length === 0) return ranked[4].acceleration; // every move crashes; they are all equivalent

  if (profile.blunderChance > 0 && rng() < profile.blunderChance) {
    return viable[Math.floor(rng() * viable.length) % viable.length].acceleration;
  }

  let best = viable[0];
  let bestScoreSoFar = Infinity;
  for (const m of viable) {
    const s = m.score + (profile.noise > 0 ? rng() * profile.noise : 0);
    if (s < bestScoreSoFar) {
      bestScoreSoFar = s;
      best = m;
    }
  }
  return best.acceleration;
}
