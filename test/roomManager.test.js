import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseBotMove } from '../src/shared/bot.js';
import { getCurrentPlayer } from '../src/shared/game.js';
import { CloseCode, ErrorCode, PROTOCOL_VERSION } from '../src/shared/protocol.js';
import { createRng } from '../src/shared/rng.js';
import { getTrack } from '../src/shared/tracks/index.js';
import { RoomManager } from '../src/server/roomManager.js';
import { FakeClock, FakeConnection } from './helpers/fixtures.js';

const oval = getTrack('oval');
const TIMING = { botMoveDelayMs: 100, reconnectGraceMs: 1_000, lobbyGraceMs: 2_000, emptyRoomTtlMs: 5_000 };

function setup(options = {}) {
  const clock = new FakeClock();
  const manager = new RoomManager({ clock, options: { ...TIMING, ...options }, rng: createRng(1) });
  let n = 0;
  const connect = (ip = '10.0.0.1') => {
    const conn = new FakeConnection(`c${++n}`);
    conn.ip = ip;
    manager.addConnection(conn);
    return conn;
  };
  const send = (conn, msg) => manager.handleRawMessage(conn.id, typeof msg === 'string' ? msg : JSON.stringify(msg));
  /** Creates a room hosted by a new connection and returns everything needed. */
  const createRoom = (settings) => {
    const host = connect();
    send(host, { type: 'create_room', name: 'Host', settings });
    const joined = host.last('joined');
    return { host, code: joined.code, hostId: joined.playerId, token: joined.token };
  };
  const join = (code, name = 'Guest') => {
    const conn = connect();
    send(conn, { type: 'join_room', code, name });
    return conn;
  };
  return { clock, manager, connect, send, createRoom, join };
}

const lastError = (conn) => conn.last('error');

/** Sends the current player's move (as chosen by a medium bot) from the right connection. */
function playTurn(ctx, conns) {
  const room = conns[0].room;
  const game = room.game;
  const current = getCurrentPlayer(game);
  const conn = conns.find((c) => c.last('joined')?.playerId === current.id);
  const acceleration = chooseBotMove(game, oval, { level: 'hard' });
  ctx.send(conn, { type: 'move', turn: game.turn, acceleration });
}

describe('RoomManager: connections and messages', () => {
  it('greets new connections with the protocol version', () => {
    const { connect } = setup();
    const conn = connect();
    assert.equal(conn.messages[0].type, 'welcome');
    assert.equal(conn.messages[0].protocol, PROTOCOL_VERSION);
  });

  it('answers pings and rejects malformed or unknown messages without disconnecting', () => {
    const { connect, send } = setup();
    const conn = connect();
    send(conn, { type: 'ping' });
    assert.ok(conn.last('pong'));
    send(conn, '{not json');
    assert.equal(lastError(conn).code, ErrorCode.BAD_MESSAGE);
    send(conn, { type: 'launch_missiles' });
    assert.equal(lastError(conn).code, ErrorCode.UNKNOWN_TYPE);
    send(conn, { type: 'move', turn: 'soon', acceleration: {} });
    assert.equal(lastError(conn).code, ErrorCode.BAD_MESSAGE);
    assert.equal(conn.closed, null);
  });

  it('rejects binary frames', () => {
    const { manager, connect } = setup();
    const conn = connect();
    manager.handleRawMessage(conn.id, null);
    assert.equal(lastError(conn).code, ErrorCode.BAD_MESSAGE);
  });

  it('rate-limits floods and eventually drops the connection', () => {
    const { connect, send } = setup({ rateLimitCapacity: 5, rateLimitPerSecond: 1, rateLimitMaxDropped: 20 });
    const conn = connect();
    for (let i = 0; i < 5; i++) send(conn, { type: 'ping' });
    assert.equal(conn.all('pong').length, 5);
    send(conn, { type: 'ping' });
    assert.equal(lastError(conn).code, ErrorCode.RATE_LIMITED);
    for (let i = 0; i < 25; i++) send(conn, { type: 'ping' });
    assert.equal(conn.all('error').length, 1, 'only one rate-limit warning per burst');
    assert.equal(conn.closed?.code, CloseCode.POLICY_VIOLATION);
  });

  it('disconnects a sustained flood even though part of it gets through', () => {
    const { clock, connect, send } = setup({ rateLimitCapacity: 5, rateLimitPerSecond: 5, rateLimitMaxDropped: 20 });
    const conn = connect();
    for (let i = 0; i < 50 && !conn.closed; i++) {
      clock.advance(100); // half a token refills per step...
      for (let k = 0; k < 3; k++) send(conn, { type: 'ping' }); // ...but three messages arrive
    }
    assert.ok(conn.all('pong').length > 5, 'some messages were still accepted');
    assert.equal(conn.closed?.code, CloseCode.POLICY_VIOLATION);
  });

  it('refills the rate-limit bucket over time', () => {
    const { clock, connect, send } = setup({ rateLimitCapacity: 2, rateLimitPerSecond: 2 });
    const conn = connect();
    for (let i = 0; i < 3; i++) send(conn, { type: 'ping' });
    assert.equal(conn.all('pong').length, 2);
    clock.advance(1_000);
    send(conn, { type: 'ping' });
    assert.equal(conn.all('pong').length, 3);
  });
});

describe('RoomManager: lobby', () => {
  it('creates a room with the creator as host and returns a session token', () => {
    const { createRoom } = setup();
    const { host, code, hostId, token } = createRoom({ laps: 2 });
    assert.match(code, /^[A-Z2-9]{5}$/);
    assert.equal(hostId, 'p1');
    assert.equal(typeof token, 'string');
    assert.ok(token.length >= 20);
    const room = host.room;
    assert.equal(room.phase, 'lobby');
    assert.equal(room.hostId, 'p1');
    assert.equal(room.settings.laps, 2);
    assert.deepEqual(room.seats.map((s) => s.name), ['Host']);
    assert.ok(!JSON.stringify(room).includes(token), 'tokens are never broadcast');
  });

  it('validates names and settings when creating', () => {
    const { connect, send } = setup();
    const conn = connect();
    send(conn, { type: 'create_room', name: '   ' });
    assert.equal(lastError(conn).code, ErrorCode.INVALID_NAME);
    send(conn, { type: 'create_room', name: 'Ann', settings: { laps: 7 } });
    assert.equal(lastError(conn).code, ErrorCode.INVALID_SETTINGS);
    assert.equal(lastError(conn).requestType, 'create_room');
  });

  it('lets others join by code (case-insensitive) and tells everyone', () => {
    const { createRoom, join } = setup();
    const { host, code } = createRoom();
    const guest = join(code.toLowerCase(), 'Guest');
    assert.equal(guest.last('joined').code, code);
    assert.deepEqual(host.room.seats.map((s) => s.name), ['Host', 'Guest']);
    assert.deepEqual(guest.room, host.room);
  });

  it('de-duplicates names within a room', () => {
    const { createRoom, join } = setup();
    const { host, code } = createRoom();
    join(code, 'host');
    join(code, 'Host');
    assert.deepEqual(host.room.seats.map((s) => s.name), ['Host', 'host 2', 'Host 3']);
  });

  it('reports unknown, malformed and full rooms', () => {
    const { createRoom, join, send, connect } = setup();
    const lost = join('ZZZZZ');
    assert.equal(lastError(lost).code, ErrorCode.ROOM_NOT_FOUND);
    const typo = join('AB');
    assert.equal(lastError(typo).code, ErrorCode.INVALID_ROOM_CODE);
    const { code } = createRoom();
    join(code, 'B');
    join(code, 'C');
    join(code, 'D');
    const fifth = join(code, 'E');
    assert.equal(lastError(fifth).code, ErrorCode.ROOM_FULL);
    const again = connect();
    send(again, { type: 'join_room', code, name: 'X' });
    send(again, { type: 'join_room', code, name: 'X' });
    assert.equal(lastError(again).code, ErrorCode.ROOM_FULL);
  });

  it('refuses to join a second room while in one', () => {
    const { createRoom, send } = setup();
    const { host, code } = createRoom();
    send(host, { type: 'join_room', code, name: 'Again' });
    assert.equal(lastError(host).code, ErrorCode.ALREADY_IN_ROOM);
    send(host, { type: 'create_room', name: 'Again' });
    assert.equal(lastError(host).code, ErrorCode.ALREADY_IN_ROOM);
  });

  it('only the host may add bots, change settings, kick or start', () => {
    const { createRoom, join, send } = setup();
    const { code } = createRoom();
    const guest = join(code);
    for (const msg of [
      { type: 'add_bot', level: 'easy' },
      { type: 'update_settings', settings: { laps: 2 } },
      { type: 'remove_player', playerId: 'p1' },
      { type: 'start_game' },
    ]) {
      send(guest, msg);
      assert.equal(lastError(guest).code, ErrorCode.NOT_HOST, msg.type);
    }
  });

  it('adds bots up to the seat limit and validates their level', () => {
    const { createRoom, send } = setup();
    const { host } = createRoom();
    send(host, { type: 'add_bot', level: 'genius' });
    assert.equal(lastError(host).code, ErrorCode.BAD_MESSAGE);
    for (const level of ['easy', 'medium', 'hard']) send(host, { type: 'add_bot', level });
    const seats = host.room.seats;
    assert.equal(seats.length, 4);
    assert.deepEqual(seats.slice(1).map((s) => [s.kind, s.botLevel, s.connected]), [
      ['bot', 'easy', true],
      ['bot', 'medium', true],
      ['bot', 'hard', true],
    ]);
    send(host, { type: 'add_bot', level: 'easy' });
    assert.equal(lastError(host).code, ErrorCode.ROOM_FULL);
  });

  it('updates settings', () => {
    const { createRoom, send } = setup();
    const { host } = createRoom();
    send(host, { type: 'update_settings', settings: { laps: 3, turnTimeLimit: 30 } });
    assert.deepEqual(host.room.settings, { trackId: 'oval', laps: 3, turnTimeLimit: 30 });
    send(host, { type: 'update_settings', settings: { turnTimeLimit: 5 } });
    assert.equal(lastError(host).code, ErrorCode.INVALID_SETTINGS);
  });

  it('kicks players (who are told) and removes bots', () => {
    const { createRoom, join, send } = setup();
    const { host, code } = createRoom();
    const guest = join(code);
    send(host, { type: 'add_bot', level: 'easy' });
    send(host, { type: 'remove_player', playerId: 'p2' });
    assert.equal(guest.last('left').reason, 'kicked');
    send(host, { type: 'remove_player', playerId: 'p3' });
    assert.deepEqual(host.room.seats.map((s) => s.playerId), ['p1']);
    send(host, { type: 'remove_player', playerId: 'p1' });
    assert.equal(lastError(host).code, ErrorCode.UNKNOWN_PLAYER);
    send(guest, { type: 'ping' });
    assert.ok(guest.last('pong'), 'kicked connection stays usable');
    send(guest, { type: 'join_room', code, name: 'Back' });
    assert.equal(guest.last('joined').code, code, 'and may rejoin');
  });

  it('transfers the host role when the host leaves, and closes empty rooms', () => {
    const { manager, createRoom, join, send } = setup();
    const { host, code } = createRoom();
    const guest = join(code);
    send(host, { type: 'add_bot', level: 'easy' });
    send(host, { type: 'leave_room' });
    assert.equal(host.last('left').reason, 'left');
    assert.equal(guest.room.hostId, 'p2');
    assert.deepEqual(guest.room.seats.map((s) => s.playerId), ['p2', 'p3']);
    send(guest, { type: 'leave_room' });
    assert.equal(manager.getRoomView(code), null, 'a room with only bots left is closed');
    assert.equal(manager.stats().rooms, 0);
  });

  it('requires at least two players to start', () => {
    const { createRoom, send } = setup();
    const { host } = createRoom();
    send(host, { type: 'start_game' });
    assert.equal(lastError(host).code, ErrorCode.NOT_ENOUGH_PLAYERS);
  });

  it('limits how many open rooms one address can create', () => {
    const { connect, send } = setup({ maxRoomsPerIp: 2 });
    for (let i = 0; i < 2; i++) {
      const conn = connect('203.0.113.9');
      send(conn, { type: 'create_room', name: `Spammer ${i}` });
      assert.ok(conn.last('joined'));
    }
    const third = connect('203.0.113.9');
    send(third, { type: 'create_room', name: 'Spammer 3' });
    assert.equal(lastError(third).code, ErrorCode.TOO_MANY_ROOMS);
    const neighbour = connect('198.51.100.7');
    send(neighbour, { type: 'create_room', name: 'Someone else' });
    assert.ok(neighbour.last('joined'), 'other addresses are unaffected');
  });

  it('refuses new rooms beyond the configured limit', () => {
    const { createRoom, connect, send } = setup({ maxRooms: 1 });
    createRoom();
    const conn = connect();
    send(conn, { type: 'create_room', name: 'Late' });
    assert.equal(lastError(conn).code, ErrorCode.SERVER_FULL);
  });
});

describe('RoomManager: racing', () => {
  function startTwoPlayerRace(settings) {
    const ctx = setup();
    const { host, code, token: hostToken } = ctx.createRoom(settings);
    const guest = ctx.join(code);
    ctx.send(host, { type: 'start_game' });
    return { ...ctx, host, guest, code, hostToken };
  }

  it('starts the race and sends every player the same state', () => {
    const { host, guest } = startTwoPlayerRace();
    assert.equal(host.room.phase, 'playing');
    assert.equal(host.room.game.players.length, 2);
    assert.deepEqual(host.room.game, guest.room.game);
    assert.equal(getCurrentPlayer(host.room.game).id, 'p1');
  });

  it('refuses to start twice or to join a running race', () => {
    const { host, code, join, send } = startTwoPlayerRace();
    send(host, { type: 'start_game' });
    assert.equal(lastError(host).code, ErrorCode.GAME_IN_PROGRESS);
    const late = join(code, 'Late');
    assert.equal(lastError(late).code, ErrorCode.GAME_IN_PROGRESS);
  });

  it('enforces turn order, turn numbers and legal accelerations', () => {
    const { host, guest, send } = startTwoPlayerRace();
    send(guest, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    assert.equal(lastError(guest).code, ErrorCode.NOT_YOUR_TURN);
    send(host, { type: 'move', turn: 5, acceleration: { x: 1, y: 0 } });
    assert.equal(lastError(host).code, ErrorCode.STALE_TURN);
    assert.equal(lastError(host).details.turn, 0);
    send(host, { type: 'move', turn: 0, acceleration: { x: 2, y: 0 } });
    assert.equal(lastError(host).code, ErrorCode.INVALID_ACCELERATION);
    assert.equal(host.room.game.turn, 0, 'rejected moves change nothing');

    send(host, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    assert.equal(host.room.game.turn, 1);
    assert.deepEqual(host.room.game.players[0].velocity, { x: 1, y: 0 });
    assert.deepEqual(guest.room.game, host.room.game, 'both players see the move');

    // A duplicate submission of the same move (e.g. a double click) is rejected as stale.
    send(host, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    assert.equal(lastError(host).code, ErrorCode.STALE_TURN);
    assert.equal(host.room.game.turn, 1);
  });

  it('rejects moves from people not in a running race', () => {
    const { connect, send, createRoom } = setup();
    const stranger = connect();
    send(stranger, { type: 'move', turn: 0, acceleration: { x: 0, y: 0 } });
    assert.equal(lastError(stranger).code, ErrorCode.NOT_IN_ROOM);
    const { host } = createRoom();
    send(host, { type: 'move', turn: 0, acceleration: { x: 0, y: 0 } });
    assert.equal(lastError(host).code, ErrorCode.GAME_NOT_RUNNING);
  });

  it('moves bots automatically after a short delay', () => {
    const { clock, createRoom, send } = setup();
    const { host } = createRoom();
    send(host, { type: 'add_bot', level: 'medium' });
    send(host, { type: 'start_game' });
    send(host, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    assert.equal(getCurrentPlayer(host.room.game).id, 'p2');
    clock.advance(99);
    assert.equal(host.room.game.turn, 1, 'the bot waits for its delay');
    clock.advance(1);
    assert.equal(host.room.game.turn, 2);
    assert.equal(host.room.game.history[1].playerId, 'p2');
    assert.equal(host.room.game.history[1].note, null);
    assert.equal(getCurrentPlayer(host.room.game).id, 'p1');
  });

  it('plays a full race to the finish, then allows a rematch', () => {
    const ctx = setup();
    const { host, code } = ctx.createRoom();
    const guest = ctx.join(code);
    ctx.send(host, { type: 'add_bot', level: 'hard' });
    ctx.send(host, { type: 'start_game' });
    for (let i = 0; i < 400 && host.room.phase === 'playing'; i++) {
      const current = getCurrentPlayer(host.room.game);
      if (current.kind === 'bot') ctx.clock.advance(100);
      else playTurn(ctx, [host, guest]);
      assert.deepEqual(guest.room.game, host.room.game);
    }
    const room = host.room;
    assert.equal(room.phase, 'finished');
    assert.equal(room.game.endReason, 'win');
    assert.ok(room.game.winnerId);
    ctx.send(host, { type: 'move', turn: room.game.turn, acceleration: { x: 0, y: 0 } });
    assert.equal(lastError(host).code, ErrorCode.GAME_NOT_RUNNING);

    ctx.send(guest, { type: 'start_game' });
    assert.equal(lastError(guest).code, ErrorCode.NOT_HOST);
    ctx.send(host, { type: 'start_game' });
    assert.equal(host.room.phase, 'playing');
    assert.equal(host.room.game.turn, 0);
  });

  it('lets new players join between races', () => {
    const ctx = setup();
    const { host, code } = ctx.createRoom();
    ctx.send(host, { type: 'add_bot', level: 'hard' });
    ctx.send(host, { type: 'start_game' });
    // Leave the race so it finishes without us (only the bot is left -> the room closes)...
    // ...instead finish quickly by making the host crash-stop until the bot wins.
    for (let i = 0; i < 200 && host.room.phase === 'playing'; i++) {
      const game = host.room.game;
      if (getCurrentPlayer(game).id === 'p1') ctx.send(host, { type: 'move', turn: game.turn, acceleration: { x: 0, y: 0 } });
      else ctx.clock.advance(100);
    }
    assert.equal(host.room.phase, 'finished');
    assert.equal(host.room.game.winnerId, 'p2');
    const late = ctx.join(code, 'Late');
    assert.equal(late.last('joined').code, code);
    assert.equal(host.room.seats.length, 3);
  });

  it('auto-moves for an idle player when the turn time limit expires', () => {
    const { clock, host, guest } = startTwoPlayerRace({ turnTimeLimit: 30 });
    const deadline = host.room.turnDeadline;
    assert.equal(deadline, clock.now() + 30_000);
    clock.advance(29_999);
    assert.equal(host.room.game.turn, 0);
    clock.advance(1);
    assert.equal(host.room.game.turn, 1);
    const move = host.room.game.history[0];
    assert.equal(move.playerId, 'p1');
    assert.equal(move.note, 'timeout');
    assert.equal(guest.room.turnDeadline, clock.now() + 30_000, 'the next player gets a fresh timer');
  });

  it('numbers the races in a room', () => {
    const { host, guest, send } = startTwoPlayerRace();
    assert.equal(host.room.raceNumber, 1);
    send(host, { type: 'move', turn: 0, acceleration: { x: 0, y: 0 } });
    assert.equal(guest.room.raceNumber, 1);
  });

  it('a repeated resume neither extends the turn nor disturbs the others', () => {
    const { clock, send, host, guest, code, hostToken } = startTwoPlayerRace({ turnTimeLimit: 30 });
    const deadline = host.room.turnDeadline;
    clock.advance(25_000);
    const before = guest.all('room').length;
    send(host, { type: 'resume', code, playerId: 'p1', token: hostToken });
    assert.equal(host.last('joined').playerId, 'p1');
    assert.equal(host.room.turnDeadline, deadline, 'same deadline');
    assert.equal(guest.all('room').length, before, 'no broadcast for a no-op resume');
    clock.advance(5_000);
    assert.equal(host.room.game.history[0].note, 'timeout');
  });

  it('taking the seat over from another tab does not extend the turn', () => {
    const { clock, connect, send, host, code, hostToken } = startTwoPlayerRace({ turnTimeLimit: 30 });
    const deadline = host.room.turnDeadline;
    clock.advance(25_000);
    const tab = connect();
    send(tab, { type: 'resume', code, playerId: 'p1', token: hostToken });
    assert.equal(tab.room.turnDeadline, deadline);
    clock.advance(5_000);
    assert.equal(tab.room.game.history[0].note, 'timeout');
  });

  it('dropping and coming back does not extend the turn either', () => {
    const { clock, manager, connect, send, host, guest, code, hostToken } = startTwoPlayerRace({ turnTimeLimit: 30 });
    const deadline = host.room.turnDeadline;
    clock.advance(29_000);
    manager.removeConnection(host.id);
    clock.advance(500); // back within the reconnect grace period (1 s in these tests)
    const back = connect();
    send(back, { type: 'resume', code, playerId: 'p1', token: hostToken });
    assert.equal(back.room.turnDeadline, deadline, 'the clock kept running while away');
    clock.advance(500);
    assert.equal(guest.room.game.history[0].note, 'timeout');
  });

  it("does not reset the current player's timer when someone else disconnects", () => {
    const { clock, manager, host, guest } = startTwoPlayerRace({ turnTimeLimit: 30 });
    const deadline = host.room.turnDeadline;
    clock.advance(10_000);
    manager.removeConnection(guest.id);
    assert.equal(host.room.turnDeadline, deadline);
    clock.advance(20_000);
    assert.equal(host.room.game.history[0].note, 'timeout');
  });
});

describe('RoomManager: disconnections', () => {
  function race(settings = { turnTimeLimit: 0 }) {
    const ctx = setup();
    const { host, code, token: hostToken } = ctx.createRoom(settings);
    const guest = ctx.join(code);
    const guestJoin = guest.last('joined');
    ctx.send(host, { type: 'start_game' });
    return { ...ctx, host, guest, code, hostToken, guestId: guestJoin.playerId, guestToken: guestJoin.token };
  }

  it('marks disconnected players, waits for them, then engages the autopilot', () => {
    const { clock, manager, send, host, guest } = race();
    send(host, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } }); // now it's the guest's turn
    manager.removeConnection(guest.id);
    const room = host.room;
    assert.equal(room.seats[1].connected, false);
    assert.deepEqual(room.waitingFor, { playerId: 'p2', until: clock.now() + 1_000 });

    clock.advance(999);
    assert.equal(host.room.game.turn, 1, 'still waiting');
    clock.advance(1);
    assert.equal(host.room.seats[1].autopilot, true);
    assert.equal(host.room.waitingFor, null);
    clock.advance(100);
    assert.equal(host.room.game.turn, 2);
    assert.equal(host.room.game.history[1].note, 'autopilot');
    // The autopilot keeps driving the absent player's later turns.
    send(host, { type: 'move', turn: 2, acceleration: { x: 1, y: 0 } });
    clock.advance(100);
    assert.equal(host.room.game.turn, 4);
  });

  it('lets a player resume their seat with their token and take back control', () => {
    const { clock, manager, connect, send, host, guest, code, guestId, guestToken } = race();
    send(host, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    manager.removeConnection(guest.id);
    clock.advance(1_000); // autopilot engaged, move pending
    const back = connect();
    send(back, { type: 'resume', code, playerId: guestId, token: guestToken });
    assert.equal(back.last('joined').playerId, guestId);
    assert.equal(back.room.seats[1].connected, true);
    assert.equal(back.room.seats[1].autopilot, false);
    clock.advance(10_000);
    assert.equal(back.room.game.turn, 1, 'the pending autopilot move was cancelled');
    send(back, { type: 'move', turn: 1, acceleration: { x: 1, y: 0 } });
    assert.equal(host.room.game.turn, 2);
  });

  it('rejects resume attempts with a bad token or for unknown rooms', () => {
    const { connect, send, code, guestId } = race();
    const intruder = connect();
    send(intruder, { type: 'resume', code, playerId: guestId, token: 'guess' });
    assert.equal(lastError(intruder).code, ErrorCode.INVALID_SESSION);
    send(intruder, { type: 'resume', code, playerId: 'p9', token: 'guess' });
    assert.equal(lastError(intruder).code, ErrorCode.INVALID_SESSION);
    send(intruder, { type: 'resume', code: 'QQQQQ', playerId: guestId, token: 'guess' });
    assert.equal(lastError(intruder).code, ErrorCode.ROOM_NOT_FOUND);
  });

  it('replaces an older connection when the same player resumes elsewhere', () => {
    const { connect, send, guest, code, guestId, guestToken, host } = race();
    const newTab = connect();
    send(newTab, { type: 'resume', code, playerId: guestId, token: guestToken });
    assert.equal(lastError(guest).code, ErrorCode.SESSION_REPLACED);
    assert.equal(guest.closed?.code, CloseCode.SESSION_REPLACED);
    assert.equal(newTab.last('joined').playerId, guestId);
    send(host, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    send(newTab, { type: 'move', turn: 1, acceleration: { x: 1, y: 0 } });
    assert.equal(host.room.game.turn, 2);
  });

  it('retires the car of a player who leaves mid-race and skips their turns', () => {
    const ctx = setup();
    const { host, code } = ctx.createRoom({ turnTimeLimit: 0 });
    const guest = ctx.join(code);
    const third = ctx.join(code, 'Third');
    ctx.send(host, { type: 'start_game' });
    ctx.send(host, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    ctx.send(guest, { type: 'leave_room' }); // leaves on their own turn
    assert.equal(guest.last('left').reason, 'left');
    const room = host.room;
    assert.equal(room.game.players[1].status, 'retired');
    assert.equal(room.seats[1].left, true);
    assert.equal(getCurrentPlayer(room.game).id, 'p3');
    ctx.send(third, { type: 'move', turn: 1, acceleration: { x: 1, y: 0 } });
    assert.equal(getCurrentPlayer(host.room.game).id, 'p1', 'the retired car is skipped');
  });

  it('pauses the race while nobody is connected and closes abandoned rooms', () => {
    const { clock, manager, createRoom, send } = setup();
    const { host, code } = createRoom();
    send(host, { type: 'add_bot', level: 'hard' });
    send(host, { type: 'start_game' });
    send(host, { type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
    manager.removeConnection(host.id);
    clock.advance(1_000);
    assert.equal(manager.getRoomView(code).game.turn, 1, 'bots do not race on alone');
    clock.advance(4_000);
    assert.equal(manager.getRoomView(code), null);
    assert.equal(manager.stats().rooms, 0);
  });

  it('keeps a disconnected lobby seat for a grace period, then frees it', () => {
    const { clock, manager, connect, send, createRoom, join } = setup();
    const { host, code } = createRoom();
    const guest = join(code);
    const { playerId, token } = guest.last('joined');
    manager.removeConnection(guest.id);
    assert.equal(host.room.seats[1].connected, false);
    clock.advance(1_500);
    const back = connect();
    send(back, { type: 'resume', code, playerId, token });
    assert.equal(back.last('joined').playerId, playerId, 'resumed within the grace period');
    manager.removeConnection(back.id);
    clock.advance(2_000);
    assert.deepEqual(host.room.seats.map((s) => s.playerId), ['p1'], 'seat freed after the grace period');
  });

  it('closes idle rooms on sweep', () => {
    const { clock, manager, createRoom } = setup({ idleRoomTtlMs: 10_000, emptyRoomTtlMs: 60_000 });
    const { host, code } = createRoom();
    clock.advance(10_001);
    manager.sweep();
    assert.equal(manager.getRoomView(code), null);
    assert.equal(host.last('left').reason, 'room-closed');
  });

  it('tells everyone when the server shuts down', () => {
    const { manager, host, guest } = race();
    manager.dispose();
    assert.equal(host.last('left').reason, 'room-closed');
    assert.equal(guest.last('left').reason, 'room-closed');
    assert.equal(manager.stats().rooms, 0);
  });
});
