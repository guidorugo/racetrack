/**
 * WebSocket transport: accepts connections on WS_PATH, forwards text frames to
 * the RoomManager, and protects the server from dead or abusive peers:
 *
 *  - ping/pong heartbeats terminate peers that stop answering (only a pong counts
 *    as a sign of life — a client that keeps sending but never reads is not alive);
 *  - a peer whose unsent backlog grows past MAX_BUFFERED_BYTES (it isn't reading)
 *    is terminated instead of buffering broadcasts for it forever;
 *  - connections are capped globally and per client address.
 */

import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { CloseCode, MAX_MESSAGE_BYTES, WS_PATH } from '../shared/protocol.js';

/** A healthy client drains snapshots immediately; this is minutes of backlog. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** How long shutdown waits for close handshakes before cutting connections. */
const CLOSE_GRACE_MS = 1_000;

/**
 * The address a request comes from. Behind a reverse proxy every request comes from
 * the proxy, so with `trustProxy` the left-most X-Forwarded-For entry is used.
 * @param {import('node:http').IncomingMessage} req @param {boolean} trustProxy
 */
export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * @param {import('node:http').Server} httpServer
 * @param {import('./roomManager.js').RoomManager} roomManager
 * @param {{
 *   logger: import('./roomManager.js').Logger,
 *   maxConnections: number,
 *   maxConnectionsPerIp: number,
 *   trustProxy: boolean,
 *   heartbeatIntervalMs: number,
 *   allowedOrigins: string[] | null,
 * }} options
 */
export function attachWebSocketGateway(httpServer, roomManager, options) {
  const { logger, maxConnections, maxConnectionsPerIp, trustProxy, heartbeatIntervalMs, allowedOrigins } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** @type {WeakMap<WebSocket, boolean>} */
  const alive = new WeakMap();
  /** @type {Map<string, number>} */
  const perIp = new Map();

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (pathname !== WS_PATH) return rejectUpgrade(socket, 404, 'Not Found');
    if (allowedOrigins && !allowedOrigins.includes(req.headers.origin ?? '')) {
      logger.warn('rejected websocket from disallowed origin', { origin: req.headers.origin ?? '' });
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const ip = clientAddress(req, trustProxy);
    if (wss.clients.size >= maxConnections) return rejectUpgrade(socket, 503, 'Service Unavailable');
    if ((perIp.get(ip) ?? 0) >= maxConnectionsPerIp) {
      logger.warn('too many connections from one address', { ip });
      return rejectUpgrade(socket, 429, 'Too Many Requests');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, ip));
  });

  wss.on('connection', (/** @type {WebSocket} */ ws, /** @type {unknown} */ _req, /** @type {string} */ ip) => {
    const id = randomUUID();
    alive.set(ws, true);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    logger.debug('websocket connected', { conn: id, ip });

    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data, isBinary) => {
      // With the default binaryType ("nodebuffer") `data` is a Buffer; ws has already
      // validated that text frames are UTF-8. Binary frames are rejected by the parser.
      roomManager.handleRawMessage(id, isBinary ? null : data.toString());
    });
    ws.on('close', () => {
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
      logger.debug('websocket closed', { conn: id });
      roomManager.removeConnection(id);
    });
    ws.on('error', (err) => logger.warn('websocket error', { conn: id, err: err.message }));

    roomManager.addConnection({
      id,
      ip,
      send(text) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          logger.warn('terminating a connection that stopped reading', { conn: id, ip, buffered: ws.bufferedAmount });
          ws.terminate();
          return;
        }
        ws.send(text);
      },
      close(code, reason) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
      },
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        logger.debug('terminating unresponsive websocket');
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  return {
    get connectionCount() {
      return wss.clients.size;
    },
    /**
     * Closes every connection (clients will try to reconnect) and stops the
     * heartbeat. Peers that don't complete the close handshake promptly are cut off.
     * @returns {Promise<void>}
     */
    close() {
      clearInterval(heartbeat);
      const open = [...wss.clients];
      return new Promise((resolve) => {
        let done = false;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => resolve());
        };
        if (open.length === 0) return finish();
        let remaining = open.length;
        timer = setTimeout(finish, CLOSE_GRACE_MS);
        timer.unref();
        for (const ws of open) {
          ws.once('close', () => {
            remaining -= 1;
            if (remaining === 0) finish();
          });
          ws.close(CloseCode.GOING_AWAY, 'Server shutting down');
        }
      });
    },
  };
}

/** @param {import('node:stream').Duplex} socket @param {number} status @param {string} text */
function rejectUpgrade(socket, status, text) {
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
  );
}
