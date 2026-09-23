import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { Connection, ConnectionStatus } from '../../src/client/js/connection.js';
import { FakeClock } from '../helpers/fixtures.js';
import { FakeWebSocket } from '../helpers/fakeWebSocket.js';

function setup(options = {}) {
  const clock = new FakeClock();
  const conn = new Connection({
    url: 'ws://test/ws',
    WebSocketImpl: FakeWebSocket,
    timers: clock,
    now: () => clock.now(),
    random: () => 0.5, // no jitter: delays are exactly initialDelayMs * 2^attempt
    initialDelayMs: 500,
    maxDelayMs: 4_000,
    maxAttempts: 4,
    heartbeatMs: 1_000,
    staleAfterMs: 3_000,
    ...options,
  });
  const statuses = [];
  const messages = [];
  conn.onStatus((s) => statuses.push(s));
  conn.onMessage((m) => messages.push(m));
  return { clock, conn, statuses, messages };
}

describe('Connection', () => {
  beforeEach(() => FakeWebSocket.reset());

  it('connects, delivers valid messages and drops malformed ones', () => {
    const { conn, statuses, messages } = setup();
    assert.equal(conn.send({ type: 'ping' }), false, 'cannot send before connecting');
    conn.open();
    assert.deepEqual(statuses, [ConnectionStatus.CONNECTING]);
    const ws = FakeWebSocket.last;
    assert.equal(ws.url, 'ws://test/ws');
    ws.serverOpen();
    assert.equal(conn.status, ConnectionStatus.OPEN);
    ws.serverSend({ type: 'welcome', protocol: 1 });
    ws.serverSend('not json');
    ws.serverSend({ type: 'mystery' });
    assert.deepEqual(messages, [{ type: 'welcome', protocol: 1 }]);
    assert.equal(conn.send({ type: 'ping' }), true);
    assert.deepEqual(ws.sent, [{ type: 'ping' }]);
  });

  it('opening twice does not create a second socket', () => {
    const { conn } = setup();
    conn.open();
    conn.open();
    assert.equal(FakeWebSocket.instances.length, 1);
  });

  it('reconnects with exponential backoff after the connection drops', () => {
    const { clock, conn, statuses } = setup();
    conn.open();
    FakeWebSocket.last.serverOpen();
    FakeWebSocket.last.serverClose(1006);
    assert.equal(conn.status, ConnectionStatus.RECONNECTING);
    clock.advance(499);
    assert.equal(FakeWebSocket.instances.length, 1);
    clock.advance(1);
    assert.equal(FakeWebSocket.instances.length, 2, 'first retry after 500 ms');
    FakeWebSocket.last.serverClose(1006);
    clock.advance(999);
    assert.equal(FakeWebSocket.instances.length, 2);
    clock.advance(1);
    assert.equal(FakeWebSocket.instances.length, 3, 'second retry after 1000 ms');
    FakeWebSocket.last.serverOpen();
    assert.equal(conn.status, ConnectionStatus.OPEN);
    assert.ok(statuses.includes(ConnectionStatus.RECONNECTING));
    // After a successful reconnect the backoff starts from scratch.
    FakeWebSocket.last.serverClose(1006);
    clock.advance(500);
    assert.equal(FakeWebSocket.instances.length, 4);
  });

  it('keeps retrying by default, at a capped interval', () => {
    const clock = new FakeClock();
    const conn = new Connection({ url: 'ws://test/ws', WebSocketImpl: FakeWebSocket, timers: clock, now: () => clock.now(), random: () => 0.5, maxDelayMs: 2_000 });
    conn.open();
    for (let i = 0; i < 30; i++) {
      FakeWebSocket.last.serverClose(1006);
      clock.advance(2_000);
    }
    assert.equal(conn.status, ConnectionStatus.CONNECTING === conn.status ? conn.status : ConnectionStatus.RECONNECTING);
    assert.equal(FakeWebSocket.instances.length, 31, 'one new attempt per capped interval');
    FakeWebSocket.last.serverOpen();
    assert.equal(conn.status, ConnectionStatus.OPEN);
  });

  it('gives up after the maximum number of attempts when one is set, and can be retried', () => {
    const { clock, conn } = setup();
    conn.open();
    for (let i = 0; i < 5; i++) {
      FakeWebSocket.last.serverClose(1006);
      clock.advance(10_000);
    }
    assert.equal(conn.status, ConnectionStatus.FAILED);
    const count = FakeWebSocket.instances.length;
    conn.open();
    assert.equal(FakeWebSocket.instances.length, count + 1);
    FakeWebSocket.last.serverOpen();
    assert.equal(conn.status, ConnectionStatus.OPEN);
  });

  it('does not reconnect when the session was taken over or after a manual close', () => {
    const { clock, conn } = setup();
    conn.open();
    FakeWebSocket.last.serverOpen();
    FakeWebSocket.last.serverClose(4000);
    clock.advance(60_000);
    assert.equal(conn.status, ConnectionStatus.REPLACED);
    assert.equal(FakeWebSocket.instances.length, 1);

    const second = setup();
    second.conn.open();
    FakeWebSocket.last.serverOpen();
    second.conn.close();
    assert.equal(second.conn.status, ConnectionStatus.CLOSED);
    assert.equal(FakeWebSocket.last.closedWith, 1000);
    second.clock.advance(60_000);
    assert.equal(FakeWebSocket.instances.length, 2);
  });

  it('pings while idle and drops a connection that has gone silent', () => {
    const { clock, conn } = setup();
    conn.open();
    const ws = FakeWebSocket.last;
    ws.serverOpen();
    clock.advance(1_000);
    assert.deepEqual(ws.sentOfType('ping').length, 1);
    ws.serverSend({ type: 'pong' });
    clock.advance(2_000);
    assert.equal(conn.status, ConnectionStatus.OPEN, 'recent traffic keeps it alive');
    clock.advance(2_000); // 4 s since the last message > staleAfterMs
    assert.equal(conn.status, ConnectionStatus.RECONNECTING);
    assert.equal(ws.readyState, 3);
  });

  it('retryNow skips the backoff wait', () => {
    const { conn } = setup({ initialDelayMs: 60_000 });
    conn.open();
    FakeWebSocket.last.serverClose(1006);
    conn.retryNow();
    assert.equal(FakeWebSocket.instances.length, 2);
  });

  it('survives a WebSocket constructor that throws', () => {
    let calls = 0;
    class Exploding {
      constructor() {
        calls++;
        throw new Error('blocked');
      }
    }
    const { clock, conn } = setup({ WebSocketImpl: Exploding });
    conn.open();
    assert.equal(conn.status, ConnectionStatus.RECONNECTING);
    clock.advance(60_000);
    assert.equal(conn.status, ConnectionStatus.FAILED);
    assert.equal(calls, 5);
  });
});
