#!/usr/bin/env node
/**
 * Racetrack server entry point: serves the game client and coordinates online races.
 * Configuration comes from environment variables (see README.md / src/server/config.js).
 */

import { startServer } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(String(/** @type {Error} */ (err).message));
  process.exit(1);
}

const logger = createLogger({ level: config.logLevel, format: config.logFormat });

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { err: String(/** @type {any} */ (reason)?.stack ?? reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception — exiting', { err: String(err.stack ?? err) });
  process.exit(1);
});

let app;
try {
  app = await startServer(config, { logger });
} catch (err) {
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  logger.error(
    e.code === 'EADDRINUSE' ? `port ${config.port} is already in use (set PORT to use another)` : 'failed to start',
    { err: String(e.message) },
  );
  process.exit(1);
}

const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
logger.info(`Racetrack is running at http://${shownHost}:${app.port}/`, { host: config.host, port: app.port });

let shuttingDown = false;
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down`);
    const force = setTimeout(() => process.exit(1), 5_000);
    force.unref();
    await app.close();
    process.exit(0);
  });
}
