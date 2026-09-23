/**
 * HTTP + WebSocket server assembly. `startServer` is used by the CLI entry point
 * (index.js) and by the integration tests.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomManager } from './roomManager.js';
import { createStaticHandler, sendText } from './staticFiles.js';
import { attachWebSocketGateway } from './wsGateway.js';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLIENT_DIR = path.join(SRC_DIR, 'client');
export const SHARED_DIR = path.join(SRC_DIR, 'shared');

const HOST_HEADER = /^[A-Za-z0-9.\-]{1,253}(:\d{1,5})?$|^\[[0-9A-Fa-f:.]{2,45}\](:\d{1,5})?$/;

/**
 * Security headers for a response. The page may only open WebSockets to the host
 * it was loaded from ('self' alone doesn't cover ws: in every browser).
 * @param {http.IncomingMessage} req
 */
function securityHeaders(req) {
  const host = req.headers.host ?? '';
  const connectSrc = HOST_HEADER.test(host) ? `'self' ws://${host} wss://${host}` : "'self'";
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src ${connectSrc}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };
}

/**
 * @typedef {Object} RunningServer
 * @property {http.Server} server
 * @property {RoomManager} roomManager
 * @property {number} port
 * @property {() => Promise<void>} close  Graceful shutdown (idempotent).
 */

/**
 * @param {import('./config.js').ServerConfig} config
 * @param {{
 *   logger: import('./roomManager.js').Logger,
 *   managerOptions?: Partial<import('./roomManager.js').DEFAULT_MANAGER_OPTIONS>,
 * }} deps
 * @returns {Promise<RunningServer>}
 */
export async function startServer(config, { logger, managerOptions = {} }) {
  const startedAt = Date.now();
  const roomManager = new RoomManager({
    logger,
    options: {
      botMoveDelayMs: config.botMoveDelayMs,
      reconnectGraceMs: config.reconnectGraceMs,
      maxRooms: config.maxRooms,
      maxRoomsPerIp: config.maxRoomsPerIp,
      ...managerOptions,
    },
  });
  roomManager.start();

  const indexFile = path.join(CLIENT_DIR, 'index.html');
  const serveStatic = createStaticHandler({
    mounts: [
      { prefix: '/client/', dir: CLIENT_DIR },
      { prefix: '/shared/', dir: SHARED_DIR },
    ],
    routes: { '/': indexFile, '/index.html': indexFile },
  });

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handleRequest(req, res) {
    for (const [name, value] of Object.entries(securityHeaders(req))) res.setHeader(name, value);
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendText(res, 400, 'Bad Request');
    }
    if (url.pathname === '/healthz') {
      const body = JSON.stringify({
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        ...roomManager.stats(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendText(res, 405, 'Method Not Allowed');
    }
    if (await serveStatic(req, res, url.pathname)) return;
    sendText(res, 404, 'Not Found');
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error('request failed', { url: req.url ?? '', err: String(err?.stack ?? err) });
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
      else res.destroy();
    });
  });

  const gateway = attachWebSocketGateway(server, roomManager, {
    logger,
    maxConnections: config.maxConnections,
    maxConnectionsPerIp: config.maxConnectionsPerIp,
    trustProxy: config.trustProxy,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    allowedOrigins: config.allowedOrigins,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  /** @type {Promise<void> | null} */
  let closing = null;
  return {
    server,
    roomManager,
    port,
    close() {
      closing ??= (async () => {
        roomManager.dispose(); // tells clients their rooms are closing
        const closed = new Promise((resolve) => server.close(() => resolve(undefined)));
        server.closeIdleConnections();
        await gateway.close(); // cuts off peers that ignore the close handshake
        const force = setTimeout(() => server.closeAllConnections(), 2_000);
        force.unref();
        await closed;
        clearTimeout(force);
      })();
      return closing;
    },
  };
}
