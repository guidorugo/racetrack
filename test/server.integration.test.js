import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { chooseBotMove } from '../src/shared/bot.js';
import { getCurrentPlayer } from '../src/shared/game.js';
import { getTrack } from '../src/shared/tracks/index.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** WebSocket test client that buffers messages and lets tests await specific ones. */
class TestClient {
  /** @param {string} url */
  static async connect(url) {
    const client = new TestClient(new WebSocket(url));
    await new Promise((resolve, reject) => {
      client.ws.once('open', resolve);
      client.ws.once('error', reject);
    });
    await client.next('welcome');
    return client;
  }

  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    /** @type {any[]} */
    this.inbox = [];
    /** @type {Array<{ predicate: (m: any) => boolean, resolve: (m: any) => void }>} */
    this.waiters = [];
    this.closed = new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      const waiter = this.waiters.find((w) => w.predicate(msg));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    });
  }

  /** @param {object} msg */
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Resolves with the first (buffered or future) message matching `type` and
   * `predicate`. Messages are consumed like a stream: buffered messages of the
   * same type that precede the match (or don't match at all) are discarded, so a
   * later call can never be satisfied by an older snapshot.
   * @param {string} type @param {(m: any) => boolean} [predicate]
   */
  next(type, predicate = () => true, timeoutMs = 3_000) {
    const match = (/** @type {any} */ m) => m.type === type && predicate(m);
    const index = this.inbox.findIndex(match);
    if (index !== -1) {
      const found = this.inbox[index];
      this.inbox = this.inbox.filter((m, i) => i > index || m.type !== type);
      return Promise.resolve(found);
    }
    this.inbox = this.inbox.filter((m) => m.type !== type);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), timeoutMs);
      this.waiters.push({
        predicate: match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** Waits for a room snapshot satisfying `predicate`. @param {(room: any) => boolean} predicate */
  async room(predicate = () => true) {
    const msg = await this.next('room', (m) => predicate(m.room));
    return msg.room;
  }

  close() {
    this.ws.close();
  }
}

describe('server integration', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let app;
  let base;
  let wsUrl;

  before(async () => {
    const config = { ...loadConfig({}), port: 0, host: '127.0.0.1', botMoveDelayMs: 20, reconnectGraceMs: 300 };
    app = await startServer(config, { logger: silent });
    base = `http://127.0.0.1:${app.port}`;
    wsUrl = `ws://127.0.0.1:${app.port}/ws`;
  });

  after(async () => {
    await app.close();
  });

  describe('HTTP', () => {
    it('serves the game page with security headers', async () => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const csp = res.headers.get('content-security-policy');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${app.port} wss://127\\.0\\.0\\.1:${app.port}(;|$)`), 'WebSockets only to this host');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(await res.text(), /<title>Racetrack<\/title>/);
    });

    it('serves client and shared modules as JavaScript, with revalidation', async () => {
      for (const path of ['/client/js/main.js', '/shared/game.js', '/shared/tracks/oval.js']) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 200, path);
        assert.match(res.headers.get('content-type'), /text\/javascript/);
        const etag = res.headers.get('etag');
        await res.arrayBuffer();
        const again = await fetch(`${base}${path}`, { headers: { 'If-None-Match': etag } });
        assert.equal(again.status, 304);
      }
    });

    it('never serves server code or files outside the public folders', async () => {
      for (const path of ['/server/app.js', '/src/server/app.js', '/package.json', '/client/..%2f..%2fpackage.json', '/client/%2e%2e/%2e%2e/package.json', '/shared/nope.js']) {
        const res = await fetch(`${base}${path}`);
        assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
        await res.arrayBuffer();
      }
      const bad = await fetch(`${base}/client/%E0%A4%A`);
      assert.equal(bad.status, 400);
    });

    it('does not leak file descriptors when clients abort downloads', { skip: !existsSync('/proc/self/fd') }, async () => {
      const openFds = () => readdirSync('/proc/self/fd').length;
      const abortOne = () =>
        new Promise((resolve) => {
          const socket = net.connect(app.port, '127.0.0.1', () => {
            socket.write('GET /client/js/gameView.js HTTP/1.1\r\nHost: x\r\n\r\n');
          });
          socket.once('data', () => {
            socket.resetAndDestroy(); // drop the connection mid-download
            resolve(undefined);
          });
          socket.on('error', () => resolve(undefined));
        });
      const before = openFds();
      for (let i = 0; i < 40; i++) await abortOne();
      await new Promise((r) => setTimeout(r, 300));
      const leaked = openFds() - before;
      assert.ok(leaked < 10, `${leaked} descriptors still open after 40 aborted downloads`);
    });

    it('rejects other HTTP methods', async () => {
      const res = await fetch(`${base}/`, { method: 'POST', body: 'x' });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    });

    it('exposes a health check', async () => {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.rooms, 'number');
    });

    it('refuses WebSocket upgrades on other paths', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}/elsewhere`);
      const status = await new Promise((resolve) => {
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
        ws.once('error', () => resolve('error'));
      });
      assert.equal(status, 404);
    });
  });

  describe('online race over real sockets', () => {
    it('keeps every client in sync from lobby to finish, with a bot in the field', async () => {
      const alice = await TestClient.connect(wsUrl);
      const bob = await TestClient.connect(wsUrl);

      alice.send({ type: 'create_room', name: 'Alice', settings: { turnTimeLimit: 0 } });
      const { code, playerId: aliceId } = await alice.next('joined');
      bob.send({ type: 'join_room', code, name: 'Bob' });
      const { playerId: bobId } = await bob.next('joined');
      await alice.room((r) => r.seats.length === 2);
      alice.send({ type: 'add_bot', level: 'hard' });
      await alice.room((r) => r.seats.length === 3);

      // A move before the race starts is refused.
      bob.send({ type: 'move', turn: 0, acceleration: { x: 0, y: 0 } });
      assert.equal((await bob.next('error')).code, 'GAME_NOT_RUNNING');

      alice.send({ type: 'start_game' });
      let room = await alice.room((r) => r.phase === 'playing');
      await bob.room((r) => r.phase === 'playing');

      const clients = { [aliceId]: alice, [bobId]: bob };
      // Humans play the moves a medium bot would pick; the bot seat drives itself.
      let guard = 0;
      while (room.phase === 'playing' && guard++ < 300) {
        const current = getCurrentPlayer(room.game);
        if (current.kind === 'human') {
          const acceleration = chooseBotMove(room.game, getTrack('oval'), { level: 'medium' });
          clients[current.id].send({ type: 'move', turn: room.game.turn, acceleration });
        }
        const turn = room.game.turn;
        room = await alice.room((r) => r.phase !== 'playing' || r.game.turn > turn);
        const bobView = await bob.room((r) => r.version === room.version);
        assert.deepEqual(bobView.game, room.game, 'both clients see identical state');
      }
      assert.equal(room.phase, 'finished');
      assert.equal(room.game.endReason, 'win');

      alice.close();
      bob.close();
    });

    it('survives a dropped connection: autopilot covers, then the player resumes', async () => {
      const host = await TestClient.connect(wsUrl);
      host.send({ type: 'create_room', name: 'Host', settings: { turnTimeLimit: 0 } });
      const { code } = await host.next('joined');
      let guest = await TestClient.connect(wsUrl);
      guest.send({ type: 'join_room', code, name: 'Guest' });
      const session = await guest.next('joined');
      host.send({ type: 'start_game' });
      await host.room((r) => r.phase === 'playing');

      host.send({ type: 'move', turn: 0, acceleration: { x: 1, y: 0 } });
      await host.room((r) => r.game?.turn === 1);
      guest.ws.terminate(); // abrupt network loss
      await host.room((r) => r.seats[1].connected === false);
      const covered = await host.room((r) => r.game?.turn === 2); // grace (300ms) + bot delay
      assert.equal(covered.game.history[1].note, 'autopilot');

      guest = await TestClient.connect(wsUrl);
      guest.send({ type: 'resume', code, playerId: session.playerId, token: session.token });
      assert.equal((await guest.next('joined')).playerId, session.playerId);
      const resumed = await host.room((r) => r.seats[1].connected && !r.seats[1].autopilot);
      assert.equal(resumed.seats[1].name, 'Guest');

      host.send({ type: 'move', turn: 2, acceleration: { x: 1, y: 0 } });
      await guest.room((r) => r.game?.turn === 3);
      guest.send({ type: 'move', turn: 3, acceleration: { x: 1, y: 0 } });
      const after = await host.room((r) => r.game?.turn === 4);
      assert.equal(after.game.history[3].note, null, 'the returning player moved themselves');

      host.close();
      guest.close();
    });

    it('answers garbage politely and keeps the connection open', async () => {
      const client = await TestClient.connect(wsUrl);
      client.ws.send('this is not json');
      assert.equal((await client.next('error')).code, 'BAD_MESSAGE');
      client.ws.send(Buffer.from([1, 2, 3]), { binary: true });
      assert.equal((await client.next('error')).code, 'BAD_MESSAGE');
      client.send({ type: 'ping' });
      assert.ok(await client.next('pong'));
      client.close();
    });

    it('closes connections that send oversized frames', async () => {
      const client = await TestClient.connect(wsUrl);
      client.ws.send('x'.repeat(64 * 1024));
      const { code } = await client.closed;
      assert.equal(code, 1009);
    });
  });
});

describe('connection limits', () => {
  it('caps concurrent connections per client address', async () => {
    const config = { ...loadConfig({}), port: 0, host: '127.0.0.1', maxConnectionsPerIp: 2 };
    const app = await startServer(config, { logger: silent });
    const url = `ws://127.0.0.1:${app.port}/ws`;
    const a = await TestClient.connect(url);
    const b = await TestClient.connect(url);
    const third = new WebSocket(url);
    const status = await new Promise((resolve) => {
      third.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      third.once('open', () => resolve('open'));
      third.once('error', () => resolve('error'));
    });
    assert.equal(status, 429);
    a.close();
    await a.closed;
    const c = await TestClient.connect(url); // a slot is free again
    b.close();
    c.close();
    await app.close();
  });
});

describe('graceful shutdown', () => {
  it('tells connected players their room closed, then closes the socket', async () => {
    const config = { ...loadConfig({}), port: 0, host: '127.0.0.1' };
    const app = await startServer(config, { logger: silent });
    const client = await TestClient.connect(`ws://127.0.0.1:${app.port}/ws`);
    client.send({ type: 'create_room', name: 'Solo' });
    await client.next('joined');
    await app.close();
    assert.equal((await client.next('left')).reason, 'room-closed');
    assert.equal((await client.closed).code, 1001);
  });

  it('does not hang on a client that stopped reading', async () => {
    const config = { ...loadConfig({}), port: 0, host: '127.0.0.1' };
    const app = await startServer(config, { logger: silent });
    const client = await TestClient.connect(`ws://127.0.0.1:${app.port}/ws`);
    /** @type {any} */ (client.ws)._socket.pause(); // never reads the close frame
    const started = Date.now();
    await app.close();
    assert.ok(Date.now() - started < 3_000, `shutdown took ${Date.now() - started} ms`);
    client.ws.terminate();
  });
});
