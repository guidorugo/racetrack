import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOT_PROFILES, chooseBotMove, rankMoves } from '../src/shared/bot.js';
import { ACCELERATIONS, BOT_LEVELS } from '../src/shared/constants.js';
import { computeDistanceField, distanceAt, getDistanceField, raceDistance } from '../src/shared/distanceField.js';
import { GameError } from '../src/shared/errors.js';
import { applyMove, createGame, evaluateMove, getMoveOptions } from '../src/shared/game.js';
import { createRng } from '../src/shared/rng.js';
import { computeStandings } from '../src/shared/standings.js';
import { getTrack } from '../src/shared/tracks/index.js';
import { makeRingTrack } from './helpers/fixtures.js';

const oval = getTrack('oval');
const ring = makeRingTrack();

function botGame(levels, extra = {}, track = oval) {
  return createGame(
    { players: levels.map((level, i) => ({ id: `b${i}`, name: `Bot ${i}`, kind: 'bot', botLevel: level })), ...extra },
    track,
  );
}

function place(state, index, position, velocity = { x: 0, y: 0 }) {
  const next = structuredClone(state);
  Object.assign(next.players[index], { position, velocity });
  return next;
}

/** Plays a game to the end with bots choosing every move. */
function playOut(state, track, seed, maxMoves = 2000) {
  const rng = createRng(seed);
  for (let i = 0; i < maxMoves && state.status === 'playing'; i++) {
    const player = state.players[state.currentPlayerIndex];
    const acceleration = chooseBotMove(state, track, { level: player.botLevel ?? 'medium', rng });
    state = applyMove(state, track, acceleration).state;
  }
  return state;
}

const isAcceleration = (a) => ACCELERATIONS.some((b) => b.x === a.x && b.y === a.y);

describe('distance field', () => {
  const field = getDistanceField(oval);

  it('reaches every point of the oval', () => {
    for (let y = 0; y <= oval.height; y++) {
      for (let x = 0; x <= oval.width; x++) {
        const d = distanceAt(field, x, y);
        if (oval.isOnTrackXY(x, y)) assert.ok(Number.isFinite(d), `(${x},${y}) reachable`);
        else assert.equal(d, Infinity, `(${x},${y}) off track`);
      }
    }
  });

  it('is one step just before the line and about a lap just after it', () => {
    assert.equal(distanceAt(field, 29, 30), 1);
    assert.ok(distanceAt(field, 30, 30) > 80, 'start line is a full lap from the finish');
    assert.ok(field.lapLength > 80 && field.lapLength < 140);
  });

  it('decreases steadily in the racing direction', () => {
    const along = [31, 36, 41].map((x) => distanceAt(field, x, 31)); // bottom straight, heading east
    assert.ok(along[0] > along[1] && along[1] > along[2]);
    assert.ok(distanceAt(field, 40, 7) > distanceAt(field, 20, 7), 'top straight is driven westwards');
  });

  it('raceDistance adds whole laps still to go', () => {
    const d = distanceAt(field, 35, 30);
    assert.equal(raceDistance(field, 35, 30, 0, 1), d);
    assert.equal(raceDistance(field, 35, 30, 0, 3), d + 2 * field.lapLength);
    assert.equal(raceDistance(field, 35, 30, -1, 1), d + field.lapLength, 'having reversed over the line costs a lap');
  });

  it('is memoised per track and works on other tracks', () => {
    assert.equal(getDistanceField(oval), field);
    const ringField = computeDistanceField(ring);
    assert.equal(distanceAt(ringField, 9, 15), 1);
    assert.ok(Number.isFinite(distanceAt(ringField, 3, 3)));
  });
});

describe('bot move selection', () => {
  it('returns one of the nine accelerations at every level', () => {
    const state = botGame(['easy', 'medium', 'hard']);
    for (const level of BOT_LEVELS) {
      assert.ok(isAcceleration(chooseBotMove(state, oval, { level, rng: createRng(1) })));
    }
  });

  it('always takes a winning move when one exists', () => {
    const state = place(botGame(['easy']), 0, { x: 28, y: 30 }, { x: 1, y: 0 });
    for (let seed = 0; seed < 20; seed++) {
      const a = chooseBotMove(state, oval, { level: 'easy', rng: createRng(seed) });
      assert.equal(evaluateMove(state, oval, 0, a).outcome, 'win');
    }
  });

  it('avoids moving onto another car', () => {
    // Bot 0 at speed along the straight; park bot 1 where the fastest safe move would land.
    let state = place(botGame(['hard', 'hard']), 0, { x: 33, y: 31 }, { x: 3, y: 0 });
    const preferred = chooseBotMove(state, oval, { level: 'hard' });
    const target = evaluateMove(state, oval, 0, preferred).target;
    state = place(state, 1, target);
    const alternative = chooseBotMove(state, oval, { level: 'hard' });
    const option = evaluateMove(state, oval, 0, alternative);
    assert.notEqual(option.outcome, 'crash');
    assert.notDeepEqual(option.target, target);
  });

  it('never crashes when a safe move exists (property test over random states)', () => {
    const rng = createRng(42);
    let checked = 0;
    for (let game = 0; game < 12; game++) {
      let state = botGame(['medium', 'medium']);
      for (let turn = 0; turn < 60 && state.status === 'playing'; turn++) {
        const options = getMoveOptions(state, oval);
        // Drive randomly (but not into walls) to reach varied states...
        const safe = options.filter((o) => o.outcome !== 'crash');
        const pick = safe.length > 0 ? safe[Math.floor(rng() * safe.length)] : options[4];
        // ...and at each state ask each level what it would do.
        if (safe.length > 0) {
          for (const level of BOT_LEVELS) {
            const a = chooseBotMove(state, oval, { level, rng });
            assert.notEqual(evaluateMove(state, oval, state.currentPlayerIndex, a).outcome, 'crash', `${level} crashed`);
            checked++;
          }
        }
        state = applyMove(state, oval, pick.acceleration).state;
      }
    }
    assert.ok(checked > 500);
  });

  it('still returns a valid move when every option crashes', () => {
    const state = place(botGame(['hard']), 0, { x: 30, y: 33 }, { x: 0, y: 6 });
    assert.ok(getMoveOptions(state, oval).every((o) => o.outcome === 'crash'));
    for (const level of BOT_LEVELS) assert.ok(isAcceleration(chooseBotMove(state, oval, { level })));
  });

  it('is deterministic for a given seed', () => {
    const a = playOut(botGame(['easy', 'medium']), oval, 7);
    const b = playOut(botGame(['easy', 'medium']), oval, 7);
    assert.deepEqual(a.history, b.history);
  });

  it('ranks crashing moves last and winning moves first', () => {
    const state = place(botGame(['medium']), 0, { x: 28, y: 34 }, { x: 1, y: 0 });
    const ranked = rankMoves(state, oval);
    const byOutcome = (o) => ranked.filter((m) => m.outcome === o);
    assert.ok(byOutcome('crash').length > 0 && byOutcome('win').length > 0);
    const worstNonCrash = Math.max(...ranked.filter((m) => m.outcome !== 'crash').map((m) => m.score));
    for (const m of byOutcome('crash')) assert.ok(m.score > worstNonCrash);
    for (const m of byOutcome('win')) assert.ok(m.score < Math.min(...byOutcome('move').map((x) => x.score)));
  });

  it('validates its inputs', () => {
    const state = botGame(['medium']);
    assert.throws(() => chooseBotMove(state, oval, { level: 'godlike' }), (e) => e instanceof GameError && e.code === 'INVALID_CONFIG');
    const over = { ...state, status: 'finished' };
    assert.throws(() => chooseBotMove(over, oval), (e) => e instanceof GameError && e.code === 'GAME_OVER');
  });

  it('accepts profile overrides', () => {
    const state = botGame(['easy']);
    const a = chooseBotMove(state, oval, { level: 'easy', profile: { depth: 1, noise: 0, blunderChance: 0 } });
    assert.ok(isAcceleration(a));
    assert.equal(BOT_PROFILES.easy.depth, 2, 'defaults are not modified');
  });
});

describe('bot racing', () => {
  it('medium and hard bots finish a lap of the oval without crashing', () => {
    for (const level of ['medium', 'hard']) {
      for (const seed of [1, 2, 3]) {
        const end = playOut(botGame([level]), oval, seed);
        assert.equal(end.endReason, 'win', `${level} seed ${seed}`);
        assert.equal(end.players[0].crashes, 0, `${level} seed ${seed} crashed`);
        assert.ok(end.players[0].moves <= 33, `${level} took ${end.players[0].moves} turns`);
      }
    }
  });

  it('hard bots are faster than easy bots', () => {
    let easy = 0;
    let hard = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      easy += playOut(botGame(['easy']), oval, seed).players[0].moves;
      hard += playOut(botGame(['hard']), oval, seed).players[0].moves;
    }
    assert.ok(hard < easy, `hard ${hard} vs easy ${easy}`);
    assert.ok(hard <= 5 * 29, 'hard is close to the optimal 28-turn lap');
  });

  it('four-bot races (and multi-lap races) always produce a winner', () => {
    for (const seed of [11, 12, 13]) {
      const end = playOut(botGame(['easy', 'medium', 'hard', 'medium'], { laps: 1 + (seed % 2) }), oval, seed);
      assert.equal(end.status, 'finished');
      assert.equal(end.endReason, 'win');
      assert.ok(end.winnerId);
    }
  });

  it('medium bots rarely crash in traffic', () => {
    let crashes = 0;
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const end = playOut(botGame(['medium', 'medium', 'medium', 'medium']), oval, seed);
      assert.equal(end.endReason, 'win');
      crashes += end.players.reduce((n, p) => n + p.crashes, 0);
    }
    assert.ok(crashes <= 4, `${crashes} crashes in 8 four-car races`);
  });

  it('works on other tracks', () => {
    const end = playOut(botGame(['hard', 'medium'], {}, ring), ring, 3);
    assert.equal(end.endReason, 'win');
  });
});

describe('standings', () => {
  it('orders the winner first, then by distance to go, then retired cars', () => {
    let state = botGame(['medium', 'medium', 'medium', 'medium']);
    state = place(state, 0, { x: 20, y: 7 }); // top straight: far along
    state = place(state, 1, { x: 40, y: 31 }); // bottom straight after the start: early
    state = place(state, 2, { x: 10, y: 30 }); // left bend, nearly home
    state.players[3].status = 'retired';
    const standings = computeStandings(state, oval);
    assert.deepEqual(standings.map((s) => s.playerId), ['b2', 'b0', 'b1', 'b3']);
    assert.deepEqual(standings.map((s) => s.rank), [1, 2, 3, 4]);

    const finished = playOut(botGame(['hard', 'easy']), oval, 5);
    const top = computeStandings(finished, oval)[0];
    assert.equal(top.playerId, finished.winnerId);
    assert.equal(top.remaining, 0);
  });
});
