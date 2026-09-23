import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalController } from '../../src/client/js/localController.js';
import { getCurrentPlayer } from '../../src/shared/game.js';
import { getTrack } from '../../src/shared/tracks/index.js';
import { FakeClock } from '../helpers/fixtures.js';

const oval = getTrack('oval');
const human = (id, name = id) => ({ id, name, kind: 'human' });
const bot = (id, level = 'hard') => ({ id, name: `Bot ${id}`, kind: 'bot', botLevel: level });

function setup(players, extra = {}) {
  const clock = new FakeClock();
  const controller = new LocalController({ mode: 'local', track: oval, players, botDelayMs: 100, seed: 1, scheduler: clock, ...extra });
  const events = [];
  controller.subscribe((e) => events.push(e));
  return { clock, controller, events };
}

describe('LocalController', () => {
  it('emits the initial state on start', () => {
    const { controller, events } = setup([human('a'), human('b')]);
    controller.start();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'state');
    assert.equal(events[0].reset, true);
    assert.deepEqual(events[0].moves, []);
    assert.equal(controller.getLocalPlayerId(), null, 'hot seat: whoever is up controls the car');
    assert.equal(controller.getTrack(), oval);
  });

  it('applies human moves and hands the turn on', () => {
    const { controller, events } = setup([human('a'), human('b')]);
    controller.start();
    assert.ok(controller.canMove());
    assert.equal(controller.submitMove({ x: 1, y: 0 }), true);
    const last = events.at(-1);
    assert.equal(last.type, 'state');
    assert.equal(last.moves.length, 1);
    assert.equal(last.moves[0].playerId, 'a');
    assert.equal(getCurrentPlayer(controller.getState()).id, 'b');
  });

  it('plays bot turns after the configured delay', () => {
    const { clock, controller } = setup([human('a'), bot('b')]);
    controller.start();
    controller.submitMove({ x: 1, y: 0 });
    assert.equal(controller.canMove(), false, 'humans cannot move for the bot');
    clock.advance(99);
    assert.equal(controller.getState().turn, 1);
    clock.advance(1);
    assert.equal(controller.getState().turn, 2);
    assert.equal(controller.getState().history[1].playerId, 'b');
    assert.ok(controller.canMove());
  });

  it('lets bots move first and honours bot speed changes', () => {
    const { clock, controller } = setup([bot('a'), human('b')]);
    controller.setBotDelay(500);
    controller.start();
    clock.advance(499);
    assert.equal(controller.getState().turn, 0);
    clock.advance(1);
    assert.equal(controller.getState().turn, 1);
  });

  it('reports moves out of turn and invalid moves as errors without changing the state', () => {
    const { controller, events } = setup([bot('a'), human('b')]);
    controller.start();
    assert.equal(controller.submitMove({ x: 1, y: 0 }), false);
    assert.equal(events.at(-1).type, 'error');
    const { controller: c2, events: e2 } = setup([human('a')]);
    c2.start();
    assert.equal(c2.submitMove({ x: 5, y: 0 }), false);
    assert.equal(e2.at(-1).type, 'error');
    assert.match(e2.at(-1).message, /nine possible moves/, 'engine errors reach the player as translated messages');
    assert.equal(c2.getState().turn, 0);
  });

  it('restarts with the same players and cancels pending bot moves', () => {
    const { clock, controller, events } = setup([human('a'), bot('b')]);
    controller.start();
    controller.submitMove({ x: 1, y: 0 });
    controller.restart();
    assert.equal(events.at(-1).reset, true);
    clock.advance(1_000);
    assert.equal(controller.getState().turn, 0, 'no stale bot move after the restart');
    assert.deepEqual(controller.getState().players.map((p) => p.id), ['a', 'b']);
  });

  it('stops everything when disposed', () => {
    const { clock, controller, events } = setup([human('a'), bot('b')]);
    controller.start();
    controller.submitMove({ x: 1, y: 0 });
    const count = events.length;
    controller.dispose();
    clock.advance(10_000);
    assert.equal(events.length, count);
    assert.equal(controller.canMove(), false);
  });

  it('runs an all-bot race to the finish', () => {
    const { clock, controller } = setup([bot('a', 'hard'), bot('b', 'medium'), bot('c', 'easy')]);
    controller.start();
    for (let i = 0; i < 500 && controller.getState().status === 'playing'; i++) clock.advance(100);
    assert.equal(controller.getState().status, 'finished');
    assert.equal(controller.getState().endReason, 'win');
  });

  it('rejects an invalid setup up front', () => {
    assert.throws(() => setup([]), /between 1 and 4 players/);
  });
});
