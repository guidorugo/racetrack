/**
 * Server configuration from environment variables. Invalid values fail fast with
 * a readable message instead of silently falling back.
 */

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

/**
 * @typedef {Object} ServerConfig
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {'text' | 'json'} logFormat
 * @property {number} botMoveDelayMs
 * @property {number} reconnectGraceMs
 * @property {number} maxRooms
 * @property {number} maxRoomsPerIp      open rooms one client address may have created
 * @property {number} maxConnections
 * @property {number} maxConnectionsPerIp
 * @property {boolean} trustProxy        take the client address from X-Forwarded-For
 * @property {number} heartbeatIntervalMs
 * @property {string[] | null} allowedOrigins  null = accept WebSocket connections from any origin
 */

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {ServerConfig}
 */
export function loadConfig(env = process.env) {
  /** @type {string[]} */
  const errors = [];

  /** @param {string} name @param {number} fallback @param {number} min @param {number} max */
  const int = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  };

  const logLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  const logFormat = (env.LOG_FORMAT ?? 'text').trim().toLowerCase();
  if (logFormat !== 'text' && logFormat !== 'json') errors.push('LOG_FORMAT must be "text" or "json"');

  const origins = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const trustProxyRaw = (env.TRUST_PROXY ?? 'false').trim().toLowerCase();
  if (!['true', 'false', '1', '0', 'yes', 'no'].includes(trustProxyRaw)) errors.push('TRUST_PROXY must be true or false');
  const trustProxy = ['true', '1', 'yes'].includes(trustProxyRaw);

  const config = {
    port: int('PORT', 8080, 0, 65535),
    host: (env.HOST ?? '0.0.0.0').trim() || '0.0.0.0',
    logLevel,
    logFormat: /** @type {'text' | 'json'} */ (logFormat),
    botMoveDelayMs: int('BOT_MOVE_DELAY_MS', 700, 0, 10_000),
    reconnectGraceMs: int('RECONNECT_GRACE_MS', 30_000, 0, 10 * 60_000),
    maxRooms: int('MAX_ROOMS', 500, 1, 100_000),
    maxRoomsPerIp: int('MAX_ROOMS_PER_IP', 10, 1, 100_000),
    maxConnections: int('MAX_CONNECTIONS', 2_000, 1, 100_000),
    maxConnectionsPerIp: int('MAX_CONNECTIONS_PER_IP', 30, 1, 100_000),
    trustProxy,
    heartbeatIntervalMs: int('HEARTBEAT_INTERVAL_MS', 15_000, 1_000, 5 * 60_000),
    allowedOrigins: origins.length > 0 ? origins : null,
  };
  if (errors.length > 0) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  return config;
}
