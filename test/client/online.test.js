import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Connection } from '../../src/client/js/connection.js';
import { OnlineGameController, OnlineSession, ServerError, socketUrlFor } from '../../src/client/js/online.js';
import { createStore } from '../../src/client/js/storage.js';
import { applyMove, createGame, retirePlayer } from '../../src/shared/game.js';
import { getTrack } from '../../src/shared/tracks/index.js';
import { FakeClock } from '../helpers/fixtures.js';
import { FakeWebSocket } from '../helpers/fakeWebSocket.js';

const oval = getTrack('oval');

function setup() {
  const clock = new FakeClock(1_000_000);
  const store = createStore(null);
  const connection = new Connection({
    url: 'ws://test/ws',
    WebSocketImpl: FakeWebSocket,
    timers: clock,
    now: () => clock.now(),
    random: () => 0.5,
  });
  const session = new OnlineSession({ connection, store, timers: clock, now: () => clock.now() });
  const events = [];
  session.subscribe((e) => events.push(e));
  return { clock, store, connection, session, events };
}

function game(turns = 0) {
  let state = createGame({ players: [{ id: 'p1', name: 'Host' }, { id: 'p2', name: 'Guest' }] }, oval);
  for (let i = 0; i < turns; i++) state = applyMove(state, oval, { x: 1, y: 0 }).state;
  return state;
}

function room(overrides = {}) {
  return {
    code: 'ABCDE',
    phase: 'lobby',
    version: 1,
    hostId: 'p1',
    settings: { trackId: 'oval', laps: 1, turnTimeLimit: 60 },
    seats: [
      { playerId: 'p1', name: 'Host', kind: 'human', botLevel: null, color: '#0072B2', connected: true, autopilot: false, left: false },
      { playerId: 'p2', name: 'Guest', kind: 'human', botLevel: null, color: '#D55E00', connected: true, autopilot: false, left: false },
    ],
    game: null,
    turnDeadline: null,
    waitingFor: null,
    serverTime: 1_000_000,
    ...overrides,
  };
}

/** Opens the socket and completes a create_room exchange as player `playerId`. */
async function joinAs(ctx, playerId = 'p1') {
  const pending = ctx.session.createRoom('Host', { laps: 1 });
  const ws = FakeWebSocket.last;
  ws.serverOpen();
  assert.deepEqual(ws.sentOfType('create_room')[0], { type: 'create_room', name: 'Host', settings: { laps: 1 } });
  ws.serverSend({ type: 'welcome', protocol: 1 });
  ws.serverSend({ type: 'joined', code: 'ABCDE', playerId, token: 'secret-token' });
  await pending;
  return ws;
}

describe('OnlineSession', () => {
  beforeEach(() => FakeWebSocket.reset());

  it('derives the socket URL from the page location', () => {
    assert.equal(socketUrlFor({ protocol: 'http:', host: 'example.com:8080' }), 'ws://example.com:8080/ws');
    assert.equal(socketUrlFor({ protocol: 'https:', host: 'race.example' }), 'wss://race.example/ws');
  });

  it('creates a room once connected, remembers the session and tracks the room', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    assert.deepEqual(ctx.session.storedSession, { code: 'ABCDE', playerId: 'p1', token: 'secret-token' });
    ws.serverSend({ type: 'room', room: room() });
    assert.equal(ctx.session.room.code, 'ABCDE');
    assert.equal(ctx.session.isHost, true);
    assert.equal(ctx.events.filter((e) => e.type === 'room').length, 1);
  });

  it('rejects a request when the server answers with an error for it', async () => {
    const ctx = setup();
    const pending = ctx.session.joinRoom('ZZZZZ', 'Guest');
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    ws.serverSend({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room ZZZZZ does not exist.', requestType: 'join_room' });
    await assert.rejects(pending, (err) => err instanceof ServerError && err.code === 'ROOM_NOT_FOUND');
    assert.equal(ctx.session.storedSession, null);
  });

  it('rejects when the server never answers, and refuses overlapping requests', async () => {
    const ctx = setup();
    const first = ctx.session.createRoom('Host', {});
    await assert.rejects(ctx.session.joinRoom('ABCDE', 'x'), /previous request/);
    ctx.clock.advance(10_000);
    await assert.rejects(first, /did not respond/);
  });

  it('forwards errors that are not tied to a pending request', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    ws.serverSend({ type: 'error', code: 'NOT_HOST', message: 'Only the host can do that.', requestType: 'start_game' });
    assert.deepEqual(ctx.events.at(-1), { type: 'error', code: 'NOT_HOST', message: 'Only the host can do that.', requestType: 'start_game' });
  });

  it('rejoins its seat automatically after the connection drops', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    ws.serverClose(1006);
    ctx.clock.advance(1_000);
    const again = FakeWebSocket.last;
    assert.notEqual(again, ws);
    again.serverOpen();
    assert.deepEqual(again.sentOfType('resume')[0], { type: 'resume', code: 'ABCDE', playerId: 'p1', token: 'secret-token' });
  });

  it('forgets the session when the server no longer knows it', async () => {
    const ctx = setup();
    ctx.store.set('online-session', { code: 'ABCDE', playerId: 'p1', token: 'old' });
    const pending = ctx.session.resume();
    FakeWebSocket.last.serverOpen();
    FakeWebSocket.last.serverSend({ type: 'error', code: 'INVALID_SESSION', message: 'That session is no longer valid.', requestType: 'resume' });
    await assert.rejects(pending, /no longer valid/);
    assert.equal(ctx.session.storedSession, null);
    assert.equal(await ctx.session.resume(), false, 'nothing left to resume');
  });

  it('handles being removed from the room', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    ws.serverSend({ type: 'room', room: room() });
    ws.serverSend({ type: 'left', reason: 'kicked' });
    assert.equal(ctx.session.room, null);
    assert.equal(ctx.session.storedSession, null);
    assert.deepEqual(ctx.events.at(-1), { type: 'left', reason: 'kicked' });
  });

  it('ignores snapshots of other rooms and malformed snapshots', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    ws.serverSend({ type: 'room', room: room({ code: 'OTHER' }) });
    ws.serverSend({ type: 'room', room: { code: 'ABCDE', phase: 'lobby', seats: 'nope', game: null } });
    ws.serverSend({ type: 'room', room: room({ game: { trackId: 'oval', players: 'bad' } }) });
    assert.equal(ctx.session.room, null);
  });

  it('asks for a reload when the server speaks another protocol version', () => {
    const ctx = setup();
    ctx.session.connect();
    FakeWebSocket.last.serverOpen();
    FakeWebSocket.last.serverSend({ type: 'welcome', protocol: 99 });
    assert.match(ctx.events.find((e) => e.type === 'error').message, /reload/);
    assert.equal(ctx.session.status, 'closed');
  });

  it('forgets the seat when another window takes it over', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    ws.serverClose(4000);
    assert.equal(ctx.session.storedSession, null);
    assert.equal(ctx.events.filter((e) => e.type === 'left').at(-1).reason, 'replaced');
  });

  it('delivers a leave made while offline once the connection is back', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', game: game(0) }) });
    ws.serverClose(1006);
    ctx.session.leaveRoom(); // offline: nothing can be sent right now
    assert.equal(ctx.session.room, null, 'the UI can move on immediately');
    assert.equal(ctx.session.storedSession, null);
    assert.equal(ctx.session.hasPendingLeave, true);
    assert.deepEqual(ctx.store.get('pending-leave', null), { code: 'ABCDE', playerId: 'p1', token: 'secret-token' }, 'survives a reload');

    ctx.clock.advance(1_000);
    const again = FakeWebSocket.last;
    again.serverOpen();
    assert.deepEqual(again.sent.map((m) => m.type), ['resume', 'leave_room'], 'reclaims the seat only to leave it');
    const eventsBefore = ctx.events.length;
    again.serverSend({ type: 'joined', code: 'ABCDE', playerId: 'p1', token: 'secret-token' });
    again.serverSend({ type: 'room', room: room({ phase: 'playing', game: game(0) }) });
    again.serverSend({ type: 'left', reason: 'left' });
    assert.equal(ctx.session.hasPendingLeave, false);
    assert.equal(ctx.store.get('pending-leave', null), null);
    assert.equal(ctx.session.room, null, 'the old room is not adopted again');
    assert.equal(ctx.session.storedSession, null);
    assert.equal(ctx.events.slice(eventsBefore).filter((e) => e.type === 'room' || e.type === 'left').length, 0);
  });

  it('completes an offline leave quietly if the room is already gone', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    ws.serverClose(1006);
    ctx.session.leaveRoom();
    ctx.clock.advance(1_000);
    FakeWebSocket.last.serverOpen();
    FakeWebSocket.last.serverSend({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'gone', requestType: 'resume' });
    FakeWebSocket.last.serverSend({ type: 'left', reason: 'left' });
    assert.equal(ctx.session.hasPendingLeave, false);
    assert.equal(ctx.events.filter((e) => e.type === 'error').length, 0, 'nothing to report');
  });

  it('leaves a room it lands in after the user cancelled the request', async () => {
    const ctx = setup();
    const pending = ctx.session.joinRoom('ABCDE', 'Guest');
    const ws = FakeWebSocket.last;
    ws.serverOpen(); // the join goes out...
    ctx.session.cancelPending(); // ...and then the user changes their mind
    await assert.rejects(pending, /Cancelled/);
    ws.serverSend({ type: 'joined', code: 'ABCDE', playerId: 'p2', token: 't' });
    assert.deepEqual(ws.sentOfType('leave_room').length, 1);
    assert.equal(ctx.session.storedSession, null);
    ws.serverSend({ type: 'room', room: room() });
    assert.equal(ctx.session.room, null);
  });

  it('drops a cancelled request that never went out', () => {
    const ctx = setup();
    const pending = ctx.session.createRoom('Host', {});
    ctx.session.cancelPending();
    FakeWebSocket.last.serverOpen();
    assert.equal(FakeWebSocket.last.sentOfType('create_room').length, 0);
    return assert.rejects(pending, /Cancelled/);
  });

  it('closes the connection only when there is nothing left to do online', async () => {
    const ctx = setup();
    const ws = await joinAs(ctx);
    ctx.session.disconnectIfIdle();
    assert.equal(ctx.session.status, 'open', 'still in a room');
    ws.serverSend({ type: 'left', reason: 'kicked' });
    ctx.session.disconnectIfIdle();
    assert.equal(ctx.session.status, 'closed');
  });

  it('reports lobby actions attempted while offline', () => {
    const ctx = setup();
    assert.equal(ctx.session.addBot('easy'), false);
    assert.equal(ctx.events.at(-1).type, 'error');
  });
});

describe('OnlineGameController', () => {
  beforeEach(() => FakeWebSocket.reset());

  async function inRace(playerId = 'p1') {
    const ctx = setup();
    const ws = await joinAs(ctx, playerId);
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', game: game(0), turnDeadline: 1_060_000, serverTime: 1_000_000 }) });
    const controller = new OnlineGameController(ctx.session);
    const events = [];
    controller.subscribe((e) => events.push(e));
    controller.start();
    return { ...ctx, ws, controller, events };
  }

  it('only lets the local player move on their own turn', async () => {
    const host = await inRace('p1');
    assert.equal(host.controller.canMove(), true);
    assert.equal(host.controller.getLocalPlayerId(), 'p1');
    FakeWebSocket.reset();
    const guest = await inRace('p2');
    assert.equal(guest.controller.canMove(), false);
    assert.equal(guest.controller.submitMove({ x: 1, y: 0 }), false);
    assert.equal(guest.events.at(-1).type, 'error');
  });

  it('sends the move with its turn number and waits for the server', async () => {
    const { ws, controller, events } = await inRace();
    assert.equal(controller.submitMove({ x: 1, y: 0 }), true);
    assert.deepEqual(ws.sentOfType('move')[0], { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    assert.equal(controller.canMove(), false, 'no double submissions while the move is in flight');
    assert.equal(controller.getMeta().moveInFlight, true);
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', game: game(1) }) });
    const last = events.at(-1);
    assert.equal(last.type, 'state');
    assert.equal(last.moves.length, 1);
    assert.equal(last.reset, false);
    assert.equal(controller.getMeta().moveInFlight, false);
  });

  it('recovers when the server rejects a move', async () => {
    const { ws, controller, events } = await inRace();
    controller.submitMove({ x: 1, y: 0 });
    ws.serverSend({ type: 'error', code: 'STALE_TURN', message: 'That move was for an earlier turn.', requestType: 'move' });
    assert.equal(events.at(-1).type, 'error');
    assert.equal(controller.canMove(), true);
  });

  it('forwards snapshots that change the race without a new move', async () => {
    const { ws, events } = await inRace();
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', game: retirePlayer(game(0), 'p2') }) });
    const last = events.at(-1);
    assert.equal(last.type, 'state');
    assert.deepEqual(last.moves, []);
    assert.equal(last.state.players[1].status, 'retired');
  });

  it('recognises a rematch by race number even if it already has more moves', async () => {
    const { ws, events } = await inRace();
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', raceNumber: 1, game: game(2) }) });
    assert.equal(events.at(-1).reset, false);
    // Missed the switch while offline: the new race already has more moves than the old one.
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', raceNumber: 2, game: game(5) }) });
    assert.equal(events.at(-1).reset, true);
    assert.deepEqual(events.at(-1).moves, []);
  });

  it('detects a new race (rematch) as a reset', async () => {
    const { ws, events } = await inRace();
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', game: game(3) }) });
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', game: game(0) }) });
    assert.equal(events.at(-1).reset, true);
  });

  it('shows server deadlines on the local clock', async () => {
    const { controller } = await inRace();
    // serverTime equals the local clock here, so the deadline is unchanged.
    assert.equal(controller.getMeta().turnDeadline, 1_060_000);
  });

  it('stops listening when disposed', async () => {
    const { ws, controller, events } = await inRace();
    controller.dispose();
    const count = events.length;
    ws.serverSend({ type: 'room', room: room({ phase: 'playing', game: game(1) }) });
    assert.equal(events.length, count);
  });
});
