/**
 * Static file serving for the browser client and the shared engine modules.
 * Only whitelisted directories are exposed ("mounts"); server code is never served.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * @typedef {{ prefix: string, dir: string }} Mount  URL prefix (ending in "/") -> directory
 */

/**
 * @param {{ mounts: Mount[], routes?: Record<string, string> }} options
 *   `routes` maps exact URL paths (e.g. "/") to files.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => Promise<boolean>}
 *   resolves to true if the request was handled
 */
export function createStaticHandler({ mounts, routes = {} }) {
  const roots = mounts.map((m) => ({ prefix: m.prefix, dir: path.resolve(m.dir) }));

  return async function serveStatic(req, res, pathname) {
    let file = Object.hasOwn(routes, pathname) ? path.resolve(routes[pathname]) : null;
    if (!file) {
      const mount = roots.find((m) => pathname.startsWith(m.prefix));
      if (!mount) return false;
      let relative;
      try {
        relative = decodeURIComponent(pathname.slice(mount.prefix.length));
      } catch {
        sendText(res, 400, 'Bad request');
        return true;
      }
      if (relative.includes('\0')) {
        sendText(res, 400, 'Bad request');
        return true;
      }
      file = path.resolve(mount.dir, `.${path.posix.sep}${relative}`);
      if (!file.startsWith(mount.dir + path.sep)) {
        sendText(res, 403, 'Forbidden');
        return true;
      }
    }

    const type = MIME_TYPES[/** @type {keyof MIME_TYPES} */ (path.extname(file).toLowerCase())];
    let info;
    try {
      info = await stat(file);
    } catch {
      info = null;
    }
    if (!info || !info.isFile() || !type) return false;

    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', info.mtime.toUTCString());
    res.setHeader('Cache-Control', 'no-cache'); // always revalidate, so updates show up immediately
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return true;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    try {
      // pipeline() destroys both streams if either side fails or the client goes
      // away mid-download, so aborted requests never leak file descriptors.
      await pipeline(createReadStream(file), res);
    } catch {
      /* client disconnected or the file vanished mid-stream; nothing else to do */
    }
    return true;
  };
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} text */
export function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
