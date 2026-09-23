/** Minimal levelled logger (text or JSON lines). */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * @param {{ level?: string, format?: 'text' | 'json', out?: { write(s: string): unknown }, err?: { write(s: string): unknown } }} [options]
 * @returns {import('./roomManager.js').Logger}
 */
export function createLogger(options = {}) {
  const threshold = LEVELS[/** @type {keyof LEVELS} */ (options.level ?? 'info')] ?? LEVELS.info;
  const format = options.format ?? 'text';
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;

  /** @param {'debug' | 'info' | 'warn' | 'error'} level @param {string} msg @param {object} [ctx] */
  const write = (level, msg, ctx) => {
    if (LEVELS[level] < threshold) return;
    const time = new Date().toISOString();
    let line;
    if (format === 'json') {
      line = JSON.stringify({ time, level, msg, ...ctx });
    } else {
      const fields = ctx
        ? Object.entries(ctx)
            .map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`)
            .join(' ')
        : '';
      line = `${time} ${level.toUpperCase().padEnd(5)} ${msg}${fields ? ` ${fields}` : ''}`;
    }
    (level === 'warn' || level === 'error' ? err : out).write(`${line}\n`);
  };

  return {
    debug: (msg, ctx) => write('debug', msg, ctx),
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
  };
}
