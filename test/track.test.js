import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_PLAYERS } from '../src/shared/constants.js';
import { GameError } from '../src/shared/errors.js';
import { Track, validateTrackDefinition } from '../src/shared/track.js';
import { DEFAULT_TRACK_ID, getTrack, hasTrack, listTracks } from '../src/shared/tracks/index.js';
import { makeRingTrack, ringDefinition } from './helpers/fixtures.js';

describe('track registry', () => {
  it('provides the default oval', () => {
    assert.equal(DEFAULT_TRACK_ID, 'oval');
    const oval = getTrack('oval');
    assert.ok(oval instanceof Track);
    assert.ok(hasTrack('oval'));
    assert.deepEqual(listTracks().map((t) => t.id), ['oval']);
  });

  it('rejects unknown ids', () => {
    assert.ok(!hasTrack('nope'));
    assert.ok(!hasTrack(42));
    assert.throws(() => getTrack('nope'), (err) => err instanceof GameError && err.code === 'UNKNOWN_TRACK');
  });
});

describe('default oval', () => {
  const oval = getTrack('oval');

  it('has enough distinct start positions on the track surface, on the finish line', () => {
    assert.ok(oval.startPositions.length >= MAX_PLAYERS);
    const keys = new Set(oval.startPositions.map((s) => `${s.x},${s.y}`));
    assert.equal(keys.size, oval.startPositions.length);
    for (const s of oval.startPositions) {
      assert.ok(oval.isOnTrack(s), `start ${s.x},${s.y} on track`);
      assert.equal(oval.finishSideXY(s.x, s.y), 0, 'cars start on the line');
    }
  });

  it('classifies surface, island, walls and the outside correctly', () => {
    assert.ok(oval.isOnTrackXY(30, 30)); // bottom straight
    assert.ok(oval.isOnTrackXY(30, 7)); // top straight
    assert.ok(oval.isOnTrackXY(7, 19)); // left bend
    assert.ok(!oval.isOnTrackXY(30, 19)); // inside the island
    assert.ok(!oval.isOnTrackXY(0, 0)); // outside the outer wall
    assert.ok(!oval.isOnTrackXY(30, 27)); // exactly on the island wall
    assert.ok(!oval.isOnTrackXY(30, 35)); // exactly on the outer wall
    assert.ok(!oval.isOnTrackXY(19, 3)); // on an outer vertex
    assert.ok(!oval.isOnTrackXY(-5, 30)); // off the grid
    assert.ok(!oval.isOnTrackXY(30.5, 30)); // not a grid point
  });
});

describe('wall collision', () => {
  const ring = makeRingTrack();

  it('allows moves that stay on the surface', () => {
    assert.ok(!ring.moveHitsWall({ x: 3, y: 15 }, { x: 8, y: 17 }));
    assert.ok(!ring.moveHitsWall({ x: 3, y: 3 }, { x: 3, y: 3 })); // standing still
  });

  it('crashes when the destination is off the track or on a wall', () => {
    assert.ok(ring.moveHitsWall({ x: 3, y: 17 }, { x: 3, y: 21 })); // through the outer wall
    assert.ok(ring.moveHitsWall({ x: 3, y: 17 }, { x: 3, y: 19 })); // ends on the wall
    assert.ok(ring.moveHitsWall({ x: 5, y: 10 }, { x: 8, y: 10 })); // into the island
  });

  it('crashes when the path crosses the island even if both ends are on track', () => {
    assert.ok(ring.isOnTrackXY(4, 10) && ring.isOnTrackXY(16, 10));
    assert.ok(ring.moveHitsWall({ x: 4, y: 10 }, { x: 16, y: 10 }));
  });

  it('treats grazing a wall corner as a crash', () => {
    // (12,14) -> (14,12) passes exactly through the island corner (13,13).
    assert.ok(ring.isOnTrackXY(12, 14) && ring.isOnTrackXY(14, 12));
    assert.ok(ring.moveHitsWall({ x: 12, y: 14 }, { x: 14, y: 12 }));
    // One step further out misses the corner.
    assert.ok(!ring.moveHitsWall({ x: 13, y: 15 }, { x: 15, y: 13 }));
  });

  it('treats sliding along a wall as a crash', () => {
    assert.ok(ring.moveHitsWall({ x: 8, y: 13 }, { x: 12, y: 13 }));
  });
});

describe('finish line crossing', () => {
  const ring = makeRingTrack();
  const cross = (x0, y0, x1, y1) => ring.finishCrossingXY(x0, y0, x1, y1);

  it('counts forward crossings as +1 and backward ones as -1', () => {
    assert.equal(cross(9, 15, 11, 15), 1);
    assert.equal(cross(11, 15, 9, 15), -1);
    assert.equal(cross(8, 14, 12, 18), 1); // diagonal
  });

  it('counts landing on the line, but not leaving it forwards again', () => {
    assert.equal(cross(9, 15, 10, 15), 1);
    assert.equal(cross(10, 15, 11, 15), 0);
    assert.equal(cross(10, 15, 9, 15), -1);
    assert.equal(cross(10, 15, 10, 17), 0); // sliding along the line
  });

  it('ignores the line when moving parallel to it or on the far side of the track', () => {
    assert.equal(cross(9, 15, 9, 17), 0);
    assert.equal(cross(9, 3, 11, 3), 0); // top straight crosses the infinite line only
    assert.equal(cross(11, 16, 14, 16), 0);
  });
});

describe('track definition validation', () => {
  it('accepts the ring fixture', () => {
    assert.deepEqual(validateTrackDefinition(ringDefinition()), []);
  });

  const invalid = [
    ['not an object', null, /must be an object/],
    ['bad id', { id: 'Bad Id!' }, /id must be/],
    ['missing name', { name: '' }, /name is required/],
    ['tiny grid', { width: 2 }, /width must be/],
    ['no boundaries', { boundaries: [] }, /boundaries must be/],
    ['point outside the grid', { boundaries: [[[0, 0], [30, 0], [0, 5]]] }, /inside the grid/],
    ['self-intersecting boundary', { boundaries: [[[1, 1], [19, 19], [19, 1], [1, 19]]] }, /not a simple polygon/],
    ['boundaries crossing each other', {
      boundaries: [[[1, 1], [19, 1], [19, 19], [1, 19]], [[7, 7], [19, 7], [13, 13], [7, 13]]],
    }, /touch or cross/],
    ['finish endpoint on the track', { finishLine: { a: [10, 14], b: [10, 19] } }, /must span the track/],
    ['direction parallel to the line', { direction: [0, 1] }, /parallel/],
    ['too few start positions', { startPositions: [[10, 14]] }, /at least 4/],
    ['start on a wall', { startPositions: [[10, 13], [10, 15], [10, 16], [10, 17]] }, /not on the track surface/],
    ['start behind the line', { startPositions: [[9, 14], [10, 15], [10, 16], [10, 17]] }, /behind the finish line/],
    ['duplicate start', { startPositions: [[10, 14], [10, 14], [10, 16], [10, 17]] }, /duplicates/],
  ];
  for (const [name, overrides, pattern] of invalid) {
    it(`rejects: ${name}`, () => {
      const def = overrides === null ? null : ringDefinition(overrides);
      const problems = validateTrackDefinition(def);
      assert.ok(problems.some((msg) => pattern.test(msg)), `expected ${pattern} in ${JSON.stringify(problems)}`);
    });
  }

  it('rejects finish lines that cross the track more than once, or not at all', () => {
    const twice = validateTrackDefinition(ringDefinition({ finishLine: { a: [10, 0], b: [10, 20] } }));
    assert.ok(twice.some((m) => /exactly once \(it crosses 2/.test(m)), JSON.stringify(twice));
    const never = validateTrackDefinition(ringDefinition({ finishLine: { a: [0, 0], b: [0, 20] } }));
    assert.ok(never.some((m) => /exactly once \(it crosses 0/.test(m)), JSON.stringify(never));
  });

  it('rejects start positions that are not at the start of a lap', () => {
    // "Ahead" of the line geometrically, but half a lap round the track.
    const def = ringDefinition({ startPositions: [[12, 3], [12, 5], [14, 3], [14, 5]] });
    assert.deepEqual(validateTrackDefinition(def), []);
    assert.throws(
      () => new Track(def),
      (err) => err instanceof GameError && err.code === 'INVALID_TRACK' && /not at the start of a lap/.test(err.message),
    );
  });

  it('the Track constructor throws a GameError listing the problems', () => {
    assert.throws(
      () => new Track(ringDefinition({ direction: [0, 1] })),
      (err) => err instanceof GameError && err.code === 'INVALID_TRACK' && Array.isArray(err.details.problems),
    );
  });
});
