import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ACCELERATIONS, PLAYER_COLORS } from '../src/shared/constants.js';
import { GameError } from '../src/shared/errors.js';
import {
  applyMove,
  createGame,
  evaluateMove,
  getCurrentPlayer,
  getMoveOptions,
  getTrail,
  isGameStateShape,
  retirePlayer,
  validateAcceleration,
} from '../src/shared/game.js';
import { getTrack } from '../src/shared/tracks/index.js';
import { makeRingTrack } from './helpers/fixtures.js';

const ring = makeRingTrack();
const oval = getTrack('oval');

/** @param {number} n @param {object} [extra] */
function newGame(n = 2, extra = {}, track = ring) {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}` }));
  return createGame({ players, ...extra }, track);
}

/** Returns a copy of `state` with the given player's car placed somewhere else. */
function place(state, index, position, velocity = { x: 0, y: 0 }, extra = {}) {
  const next = structuredClone(state);
  Object.assign(next.players[index], { position, velocity, ...extra });
  return next;
}

const isCode = (code) => (err) => err instanceof GameError && err.code === code;

/** Recursively freezes an object so accidental mutation throws. */
function deepFreeze(obj) {
  for (const value of Object.values(obj)) if (value && typeof value === 'object') deepFreeze(value);
  return Object.freeze(obj);
}

describe('createGame', () => {
  it('puts every car on its start position, stationary, with seat colours', () => {
    const state = newGame(4, {}, oval);
    assert.equal(state.status, 'playing');
    assert.equal(state.turn, 0);
    assert.equal(state.round, 1);
    assert.equal(state.currentPlayerIndex, 0);
    assert.equal(state.laps, 1);
    state.players.forEach((p, i) => {
      assert.deepEqual(p.position, oval.startPositions[i]);
      assert.deepEqual(p.startPosition, oval.startPositions[i]);
      assert.deepEqual(p.velocity, { x: 0, y: 0 });
      assert.equal(p.color, PLAYER_COLORS[i]);
      assert.equal(p.status, 'racing');
      assert.equal(p.kind, 'human');
      assert.equal(p.botLevel, null);
    });
  });

  it('supports bots and defaults their level to medium', () => {
    const state = createGame(
      { players: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', kind: 'bot' }, { id: 'c', name: 'C', kind: 'bot', botLevel: 'hard' }] },
      ring,
    );
    assert.equal(state.players[1].botLevel, 'medium');
    assert.equal(state.players[2].botLevel, 'hard');
  });

  it('sanitises player names', () => {
    const state = createGame({ players: [{ id: 'a', name: '  Ada\u0000  Lovelace‮  ' }] }, ring);
    assert.equal(state.players[0].name, 'Ada Lovelace');
  });

  const invalid = [
    ['no players', { players: [] }],
    ['five players', { players: [1, 2, 3, 4, 5].map((i) => ({ id: `p${i}`, name: `P${i}` })) }],
    ['duplicate ids', { players: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }],
    ['missing id', { players: [{ name: 'A' }] }],
    ['blank name', { players: [{ id: 'a', name: '   ' }] }],
    ['unknown kind', { players: [{ id: 'a', name: 'A', kind: 'alien' }] }],
    ['unknown bot level', { players: [{ id: 'a', name: 'A', kind: 'bot', botLevel: 'godlike' }] }],
    ['bad colour', { players: [{ id: 'a', name: 'A', color: 'red' }] }],
    ['zero laps', { players: [{ id: 'a', name: 'A' }], laps: 0 }],
    ['too many laps', { players: [{ id: 'a', name: 'A' }], laps: 9 }],
    ['fractional maxRounds', { players: [{ id: 'a', name: 'A' }], maxRounds: 1.5 }],
  ];
  for (const [name, config] of invalid) {
    it(`rejects ${name}`, () => {
      assert.throws(() => createGame(config, ring), isCode('INVALID_CONFIG'));
    });
  }
  it('rejects a missing config or track', () => {
    assert.throws(() => createGame(null, ring), isCode('INVALID_CONFIG'));
    assert.throws(() => createGame({ players: [{ id: 'a', name: 'A' }] }, null), isCode('INVALID_CONFIG'));
  });
});

describe('movement', () => {
  it('offers the nine points around position + velocity, in numpad order', () => {
    const state = place(newGame(1), 0, { x: 4, y: 15 }, { x: 2, y: -1 });
    const options = getMoveOptions(state, ring);
    assert.equal(options.length, 9);
    options.forEach((o, i) => {
      assert.equal(o.index, i);
      assert.deepEqual(o.acceleration, ACCELERATIONS[i]);
      assert.deepEqual(o.velocity, { x: 2 + ACCELERATIONS[i].x, y: -1 + ACCELERATIONS[i].y });
      assert.deepEqual(o.target, { x: 6 + ACCELERATIONS[i].x, y: 14 + ACCELERATIONS[i].y });
    });
    assert.deepEqual(options[4].target, { x: 6, y: 14 }, 'centre option keeps the velocity');
  });

  it('updates velocity then position, and records the move', () => {
    let state = place(newGame(2), 0, { x: 4, y: 15 }, { x: 1, y: 0 });
    const { state: next, move } = applyMove(state, ring, { x: 1, y: 1 });
    assert.deepEqual(next.players[0].velocity, { x: 2, y: 1 });
    assert.deepEqual(next.players[0].position, { x: 6, y: 16 });
    assert.equal(next.players[0].moves, 1);
    assert.deepEqual(move, {
      turn: 1,
      round: 1,
      playerId: 'p1',
      acceleration: { x: 1, y: 1 },
      from: { x: 4, y: 15 },
      target: { x: 6, y: 16 },
      to: { x: 6, y: 16 },
      velocity: { x: 2, y: 1 },
      outcome: 'moved',
      crash: null,
      lapDelta: 0,
      note: null,
    });
    assert.deepEqual(next.history, [move]);
    assert.equal(next.turn, 1);
  });

  it('lets a stationary car stay where it is', () => {
    const state = newGame(2);
    const { state: next, move } = applyMove(state, ring, { x: 0, y: 0 });
    assert.equal(move.outcome, 'moved');
    assert.deepEqual(next.players[0].position, state.players[0].position);
  });

  it('never mutates the input state', () => {
    const state = deepFreeze(newGame(2));
    const { state: next } = applyMove(state, ring, { x: 1, y: 0 });
    assert.notEqual(next, state);
    assert.deepEqual(state.players[0].velocity, { x: 0, y: 0 });
  });

  it('keeps state JSON round-trippable', () => {
    let state = newGame(3);
    for (const a of [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: -1, y: 0 }]) state = applyMove(state, ring, a).state;
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    assert.ok(isGameStateShape(JSON.parse(JSON.stringify(state))));
  });
});

describe('turn order', () => {
  it('cycles through players and counts rounds', () => {
    let state = newGame(3);
    const seen = [];
    for (let i = 0; i < 7; i++) {
      seen.push([getCurrentPlayer(state).id, state.round]);
      state = applyMove(state, ring, { x: 0, y: 0 }).state;
    }
    assert.deepEqual(seen, [
      ['p1', 1], ['p2', 1], ['p3', 1],
      ['p1', 2], ['p2', 2], ['p3', 2],
      ['p1', 3],
    ]);
  });

  it('rejects moves by the wrong player without changing the state', () => {
    const state = newGame(2);
    assert.throws(() => applyMove(state, ring, { x: 1, y: 0 }, { playerId: 'p2' }), isCode('NOT_YOUR_TURN'));
    assert.equal(applyMove(state, ring, { x: 1, y: 0 }, { playerId: 'p1' }).state.turn, 1);
  });

  it('skips retired players and hands the turn on when the current player retires', () => {
    let state = newGame(3);
    state = retirePlayer(state, 'p2');
    assert.equal(state.players[1].status, 'retired');
    state = applyMove(state, ring, { x: 0, y: 0 }).state; // p1
    assert.equal(getCurrentPlayer(state).id, 'p3');
    state = retirePlayer(state, 'p3'); // current player leaves
    assert.equal(getCurrentPlayer(state).id, 'p1');
    assert.equal(state.round, 2);
  });

  it('ends the game when every car has retired', () => {
    let state = newGame(2);
    state = retirePlayer(retirePlayer(state, 'p1'), 'p2');
    assert.equal(state.status, 'finished');
    assert.equal(state.endReason, 'all-retired');
    assert.equal(state.winnerId, null);
  });

  it('retirePlayer rejects unknown players and is a no-op when repeated', () => {
    const state = retirePlayer(newGame(2), 'p2');
    assert.throws(() => retirePlayer(state, 'ghost'), isCode('UNKNOWN_PLAYER'));
    assert.equal(retirePlayer(state, 'p2'), state);
  });

  it('ends in a draw when the round limit is reached', () => {
    let state = newGame(2, { maxRounds: 2 });
    for (let i = 0; i < 4; i++) state = applyMove(state, ring, { x: 0, y: 0 }).state;
    assert.equal(state.status, 'finished');
    assert.equal(state.endReason, 'round-limit');
    assert.equal(state.winnerId, null);
    assert.throws(() => applyMove(state, ring, { x: 0, y: 0 }), isCode('GAME_OVER'));
  });
});

describe('invalid input', () => {
  const bad = [{ x: 2, y: 0 }, { x: 0, y: -2 }, { x: 0.5, y: 0 }, { x: '1', y: 0 }, { x: 1 }, null, 'up', [1, 0], { x: NaN, y: 0 }];
  for (const acc of bad) {
    it(`rejects acceleration ${JSON.stringify(acc)}`, () => {
      const state = newGame(2);
      assert.throws(() => applyMove(state, ring, acc), isCode('INVALID_ACCELERATION'));
      assert.throws(() => validateAcceleration(acc), isCode('INVALID_ACCELERATION'));
    });
  }

  it('normalises -0', () => {
    assert.ok(Object.is(validateAcceleration({ x: -0, y: 0 }).x, 0));
  });

  it('refuses to apply a move with the wrong track', () => {
    assert.throws(() => applyMove(newGame(2), oval, { x: 0, y: 0 }), isCode('UNKNOWN_TRACK'));
  });
});

describe('collisions', () => {
  it('a wall crash ends the turn: the car stays put and loses all speed', () => {
    const state = place(newGame(2), 0, { x: 4, y: 16 }, { x: 0, y: 2 });
    const option = evaluateMove(state, ring, 0, { x: 0, y: 1 });
    assert.equal(option.outcome, 'crash');
    assert.equal(option.crash, 'wall');
    const { state: next, move } = applyMove(state, ring, { x: 0, y: 1 });
    assert.equal(move.outcome, 'crashed');
    assert.equal(move.crash, 'wall');
    assert.deepEqual(move.target, { x: 4, y: 19 });
    assert.deepEqual(move.to, { x: 4, y: 16 });
    assert.deepEqual(next.players[0].position, { x: 4, y: 16 });
    assert.deepEqual(next.players[0].velocity, { x: 0, y: 0 });
    assert.equal(next.players[0].crashes, 1);
    assert.equal(getCurrentPlayer(next).id, 'p2', 'the turn passes on');
  });

  it('moving through the island is a crash even though both ends are on track', () => {
    const state = place(newGame(1), 0, { x: 4, y: 10 }, { x: 11, y: 0 });
    assert.equal(applyMove(state, ring, { x: 1, y: 0 }).move.crash, 'wall');
  });

  it('moving onto another car is a crash; the other car is unaffected', () => {
    let state = newGame(2);
    state = place(state, 1, { x: 12, y: 14 }, { x: 0, y: 0 });
    state = place(state, 0, { x: 10, y: 14 }, { x: 1, y: 0 });
    const option = evaluateMove(state, ring, 0, { x: 1, y: 0 });
    assert.equal(option.crash, 'car');
    assert.equal(option.blockedBy, 'p2');
    const { state: next, move } = applyMove(state, ring, { x: 1, y: 0 });
    assert.equal(move.crash, 'car');
    assert.deepEqual(next.players[0].position, { x: 10, y: 14 });
    assert.deepEqual(next.players[1].position, { x: 12, y: 14 });
    assert.equal(next.players[1].crashes, 0);
  });

  it('cars may pass over each other; only the destination matters', () => {
    let state = newGame(2);
    state = place(state, 1, { x: 12, y: 15 });
    state = place(state, 0, { x: 11, y: 15 }, { x: 1, y: 0 });
    assert.equal(applyMove(state, ring, { x: 1, y: 0 }).move.outcome, 'moved'); // 11 -> 13, over 12
  });

  it('retired cars do not block anyone', () => {
    let state = newGame(2);
    state = place(state, 1, { x: 12, y: 14 });
    state = retirePlayer(state, 'p2');
    state = place(state, 0, { x: 10, y: 14 }, { x: 1, y: 0 });
    assert.equal(applyMove(state, ring, { x: 1, y: 0 }).move.outcome, 'moved');
  });

  it('still lets the player choose when every option crashes', () => {
    const state = place(newGame(1), 0, { x: 4, y: 17 }, { x: 0, y: 5 });
    const options = getMoveOptions(state, ring);
    assert.ok(options.every((o) => o.outcome === 'crash'));
    const { state: next } = applyMove(state, ring, { x: 0, y: -1 });
    assert.deepEqual(next.players[0].velocity, { x: 0, y: 0 });
  });
});

describe('winning', () => {
  /** Car 1 sits just behind the finish line heading east, clear of the cars parked on it. */
  let state;
  beforeEach(() => {
    state = place(newGame(3), 0, { x: 8, y: 18 }, { x: 1, y: 0 });
  });

  it('a car parked on the line blocks the finishing point like any other car', () => {
    const s = place(state, 0, { x: 8, y: 15 }, { x: 1, y: 0 }); // (10,15) holds player 2
    const { move } = applyMove(s, ring, { x: 1, y: 0 });
    assert.equal(move.outcome, 'crashed');
    assert.equal(move.crash, 'car');
  });

  it('crossing the finish line in the racing direction wins and ends the game at once', () => {
    const option = evaluateMove(state, ring, 0, { x: 1, y: 0 });
    assert.equal(option.outcome, 'win');
    const { state: next, move } = applyMove(state, ring, { x: 1, y: 0 });
    assert.equal(move.outcome, 'won');
    assert.equal(move.lapDelta, 1);
    assert.equal(next.status, 'finished');
    assert.equal(next.endReason, 'win');
    assert.equal(next.winnerId, 'p1');
    assert.equal(next.players[0].status, 'finished');
    assert.equal(getCurrentPlayer(next), null, 'nobody else gets a turn');
    assert.deepEqual(getMoveOptions(next, ring), []);
    assert.throws(() => applyMove(next, ring, { x: 0, y: 0 }), isCode('GAME_OVER'));
  });

  it('landing exactly on the finish line counts as crossing it', () => {
    const s = place(state, 0, { x: 8, y: 18 }, { x: 2, y: 0 });
    assert.equal(applyMove(s, ring, { x: 0, y: 0 }).move.outcome, 'won'); // 8 -> 10
  });

  it('a crashing move never wins, even if it would cross the line', () => {
    const s = place(state, 0, { x: 8, y: 17 }, { x: 4, y: 2 });
    const { state: next, move } = applyMove(s, ring, { x: 0, y: 0 }); // (8,17) -> (12,19) hits the wall
    assert.equal(move.outcome, 'crashed');
    assert.equal(next.status, 'playing');
    assert.equal(next.players[0].lapProgress, 0);
  });

  it('crossing backwards does not win and has to be undone first', () => {
    // Start on the line (lap progress 0), reverse over it, then drive forward over it again.
    let s = place(newGame(1), 0, { x: 10, y: 15 });
    let r = applyMove(s, ring, { x: -1, y: 0 }); // 10 -> 9: backwards
    assert.equal(r.move.lapDelta, -1);
    assert.equal(r.state.players[0].lapProgress, -1);
    r = applyMove(r.state, ring, { x: 1, y: 0 }); // v=0: 9 -> 9
    r = applyMove(r.state, ring, { x: 1, y: 0 }); // v=1: 9 -> 10: forwards again
    assert.equal(r.move.lapDelta, 1);
    assert.equal(r.move.outcome, 'moved', 'net zero laps: no win');
    assert.equal(r.state.status, 'playing');
    assert.equal(r.state.players[0].lapProgress, 0);
  });

  it('driving off the start line does not count as a crossing', () => {
    const s = newGame(1); // starts on the line at (10, 14)
    const r = applyMove(s, ring, { x: 1, y: 0 });
    assert.equal(r.move.lapDelta, 0);
    assert.equal(r.state.players[0].lapProgress, 0);
  });

  it('multi-lap races need one forward crossing per lap', () => {
    let s = place(newGame(1, { laps: 2 }), 0, { x: 8, y: 15 }, { x: 1, y: 0 });
    let r = applyMove(s, ring, { x: 1, y: 0 });
    assert.equal(r.move.outcome, 'moved');
    assert.equal(r.state.players[0].lapProgress, 1);
    s = place(r.state, 0, { x: 8, y: 15 }, { x: 1, y: 0 }, { lapProgress: 1 });
    r = applyMove(s, ring, { x: 1, y: 0 });
    assert.equal(r.move.outcome, 'won');
  });
});

describe('trails and state checks', () => {
  it('getTrail lists visited positions; crashes add nothing', () => {
    let state = newGame(1);
    state = applyMove(state, ring, { x: 1, y: 0 }).state; // (10,14) -> (11,14)
    state = applyMove(state, ring, { x: 0, y: -1 }).state; // v (1,-1) -> (12,13): on the island wall
    assert.equal(state.players[0].crashes, 1);
    assert.deepEqual(getTrail(state, 'p1'), [{ x: 10, y: 14 }, { x: 11, y: 14 }]);
    assert.deepEqual(getTrail(state, 'nobody'), []);
  });

  it('isGameStateShape rejects malformed data', () => {
    const good = newGame(2);
    assert.ok(isGameStateShape(good));
    assert.ok(!isGameStateShape(null));
    assert.ok(!isGameStateShape({ ...good, status: 'weird' }));
    assert.ok(!isGameStateShape({ ...good, currentPlayerIndex: 5 }));
    assert.ok(!isGameStateShape({ ...good, players: [{ id: 'x' }] }));
    assert.ok(!isGameStateShape({ ...good, history: 'nope' }));
  });
});
