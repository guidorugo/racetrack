import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARROWS, describeMove, describeOption, fmtPoint, fmtVector, levelLabel, ordinal, secondsLeft } from '../../src/client/js/format.js';
import { animatedPosition } from '../../src/client/js/renderer.js';
import { createStore } from '../../src/client/js/storage.js';
import { computeViewport, pickOption, pickRadius, toGrid, toScreen } from '../../src/client/js/viewport.js';

describe('viewport', () => {
  it('fits and centres the grid in the canvas', () => {
    const vp = computeViewport(640, 400, 60, 38, 1);
    assert.equal(vp.scale, 10); // limited by width: 640 / 62
    assert.equal(toScreen(vp, 0, 0).x, 20);
    assert.equal(toScreen(vp, 60, 0).x, 620);
    const mid = toScreen(vp, 30, 19);
    assert.deepEqual(mid, { x: 320, y: 200 });
  });

  it('round-trips between grid and screen coordinates', () => {
    const vp = computeViewport(1000, 700, 60, 38, 1.2);
    const p = toScreen(vp, 17, 23);
    assert.deepEqual(toGrid(vp, p.x, p.y), { x: 17, y: 23 });
  });

  it('never collapses to a zero scale', () => {
    assert.equal(computeViewport(1, 1, 60, 38).scale, 1);
  });

  it('picks the nearest option within the radius only', () => {
    const vp = computeViewport(620, 400, 60, 38, 1);
    const options = [{ target: { x: 10, y: 10 } }, { target: { x: 11, y: 10 } }];
    const a = toScreen(vp, 10, 10);
    assert.equal(pickOption(vp, options, a.x + 2, a.y, pickRadius(vp)), 0);
    assert.equal(pickOption(vp, options, a.x + 7, a.y, pickRadius(vp)), 1);
    assert.equal(pickOption(vp, options, a.x, a.y + 30, pickRadius(vp)), -1);
  });
});

describe('format', () => {
  it('formats points, vectors and ordinals', () => {
    assert.equal(fmtPoint({ x: 3, y: -4 }), '(3, -4)');
    assert.equal(fmtVector({ x: 1, y: 0 }), '⟨1, 0⟩');
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    assert.equal(levelLabel('hard'), 'Hard');
    assert.equal(levelLabel(null), '');
    assert.equal(ARROWS.length, 9);
  });

  const base = { from: { x: 1, y: 1 }, target: { x: 3, y: 1 }, to: { x: 3, y: 1 }, velocity: { x: 2, y: 0 }, crash: null, lapDelta: 0, note: null };
  it('describes every kind of move for the log', () => {
    const race = { laps: 2, lapProgress: 1 };
    assert.equal(describeMove({ ...base, outcome: 'moved' }, 'Ann', race), 'Ann → (3, 1), speed 2');
    assert.equal(describeMove({ ...base, outcome: 'moved', velocity: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, 'Ann', race), 'Ann stays at (1, 1)');
    assert.equal(describeMove({ ...base, outcome: 'crashed', crash: 'wall' }, 'Ann', race), 'Ann crashes into the wall');
    assert.equal(describeMove({ ...base, outcome: 'crashed', crash: 'car' }, 'Ann', race), 'Ann crashes into another car');
    assert.equal(describeMove({ ...base, outcome: 'won' }, 'Ann', race), 'Ann crosses the finish line and wins!');
    assert.equal(describeMove({ ...base, outcome: 'moved', lapDelta: 1 }, 'Ann', race), 'Ann completes lap 1 of 2');
    assert.equal(describeMove({ ...base, outcome: 'moved', lapDelta: -1 }, 'Ann', race), 'Ann crosses the line backwards');
    assert.match(describeMove({ ...base, outcome: 'moved', note: 'timeout' }, 'Ann', race), /time ran out/);
    assert.match(describeMove({ ...base, outcome: 'moved', note: 'autopilot' }, 'Ann', race), /\(autopilot\)$/);
  });

  it('describes move options', () => {
    const option = { target: { x: 5, y: 6 }, velocity: { x: 2, y: -3 }, crash: null };
    assert.equal(describeOption({ ...option, outcome: 'move' }), 'Move to (5, 6), speed 3');
    assert.match(describeOption({ ...option, outcome: 'win' }), /^Finish!/);
    assert.match(describeOption({ ...option, outcome: 'crash', crash: 'wall' }), /hits the wall/);
    assert.match(describeOption({ ...option, outcome: 'crash', crash: 'car' }), /another car/);
  });

  it('counts down whole seconds and never goes negative', () => {
    assert.equal(secondsLeft(10_500, 10_000), 1);
    assert.equal(secondsLeft(10_000, 12_000), 0);
  });
});

describe('storage', () => {
  it('falls back to memory when storage is unavailable', () => {
    const store = createStore(null);
    assert.equal(store.get('missing', 'fallback'), 'fallback');
    store.set('name', 'Ada');
    assert.equal(store.get('name', null), 'Ada');
    store.remove('name');
    assert.equal(store.get('name', null), null);
  });

  it('survives a storage that throws and corrupt entries', () => {
    const broken = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('quota');
      },
      removeItem() {
        throw new Error('denied');
      },
    };
    const store = createStore(/** @type {any} */ (broken));
    store.set('k', { a: 1 });
    assert.deepEqual(store.get('k', null), { a: 1 });
    const map = new Map([['racetrack.bad', '{not json']]);
    const corrupt = createStore(/** @type {any} */ ({ getItem: (k) => map.get(k) ?? null, setItem() {}, removeItem() {} }));
    assert.equal(corrupt.get('bad', 'fallback'), 'fallback');
  });
});

describe('move animation', () => {
  it('eases towards the destination', () => {
    const anim = { playerId: 'a', from: { x: 0, y: 0 }, to: { x: 10, y: 0 }, target: { x: 10, y: 0 }, crash: false, t: 0 };
    assert.deepEqual(animatedPosition({ ...anim, t: 0 }), { x: 0, y: 0 });
    assert.deepEqual(animatedPosition({ ...anim, t: 1 }), { x: 10, y: 0 });
    assert.ok(animatedPosition({ ...anim, t: 0.5 }).x > 5, 'ease-out: more than half way at half time');
  });

  it('bounces back from a crash', () => {
    const anim = { playerId: 'a', from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, target: { x: 10, y: 0 }, crash: true, t: 0.5 };
    const mid = animatedPosition(anim);
    assert.ok(mid.x > 0 && mid.x < 10);
    assert.deepEqual(animatedPosition({ ...anim, t: 1 }).x < 1e-9, true);
  });
});
