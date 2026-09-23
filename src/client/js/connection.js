/**
 * Resilient WebSocket connection for the browser client.
 *
 *  - Reconnects automatically with exponential backoff (plus jitter, capped at
 *    `maxDelayMs`) after network drops or server restarts, and keeps trying for as
 *    long as the connection is wanted — a player in a race must never be stranded
 *    because the outage lasted a little longer than expected.
 *  - Sends periodic pings and treats a silent connection as dead, which catches
 *    half-open connections (e.g. a laptop waking from sleep) that never fire `close`.
 *  - Does not reconnect after fatal closes (session opened elsewhere, policy
 *    violation, protocol mismatch) — reconnecting would not help.
 *
 * Everything environment-specific (WebSocket, timers, clock, randomness) is
 * injectable so the behaviour is unit-testable in Node.
 */

import { CloseCode, parseServerMessage } from '../../shared/protocol.js';

export const ConnectionStatus = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  OPEN: 'open',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed',
  REPLACED: 'replaced',
  CLOSED: 'closed',
});

/** @typedef {typeof ConnectionStatus[keyof typeof ConnectionStatus]} Status */

const OPEN_STATE = 1;
const FATAL_CODES = new Map([
  [CloseCode.SESSION_REPLACED, ConnectionStatus.REPLACED],
  [CloseCode.PROTOCOL_MISMATCH, ConnectionStatus.FAILED],
  [CloseCode.POLICY_VIOLATION, ConnectionStatus.FAILED],
]);

/**
 * @typedef {Object} ConnectionOptions
 * @property {string} url
 * @property {any} [WebSocketImpl]
 * @property {{ setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function }} [timers]
 * @property {() => number} [now]
 * @property {() => number} [random]
 * @property {number} [initialDelayMs]
 * @property {number} [maxDelayMs]
 * @property {number} [maxAttempts]   Infinity by default; a finite value ends in 'failed'.
 * @property {number} [heartbeatMs]
 * @property {number} [staleAfterMs]
 */

export class Connection {
  /** @type {Required<ConnectionOptions>} */
  #opts;
  /** @type {any} */
  #ws = null;
  /** @type {Status} */
  #status = ConnectionStatus.IDLE;
  #attempt = 0;
  /** @type {unknown} */
  #reconnectTimer = null;
  /** @type {unknown} */
  #heartbeatTimer = null;
  #lastMessageAt = 0;
  #manualClose = false;
  /** @type {Set<(message: any) => void>} */
  #messageListeners = new Set();
  /** @type {Set<(status: Status) => void>} */
  #statusListeners = new Set();

  /** @param {ConnectionOptions} options */
  constructor(options) {
    this.#opts = {
      WebSocketImpl: globalThis.WebSocket,
      timers: globalThis,
      now: () => Date.now(),
      random: Math.random,
      initialDelayMs: 500,
      maxDelayMs: 8_000,
      maxAttempts: Infinity,
      heartbeatMs: 15_000,
      staleAfterMs: 40_000,
      ...options,
    };
  }

  get status() {
    return this.#status;
  }

  get isOpen() {
    return this.#status === ConnectionStatus.OPEN;
  }

  /** @param {(message: any) => void} fn */
  onMessage(fn) {
    this.#messageListeners.add(fn);
    return () => this.#messageListeners.delete(fn);
  }

  /** @param {(status: Status) => void} fn */
  onStatus(fn) {
    this.#statusListeners.add(fn);
    return () => this.#statusListeners.delete(fn);
  }

  /** Connects (or retries after a failure). Safe to call repeatedly. */
  open() {
    this.#manualClose = false;
    if (this.#ws) return;
    this.#clearReconnect();
    this.#attempt = 0;
    this.#connect();
  }

  /** Skips the backoff wait and tries again now (e.g. when the browser comes back online). */
  retryNow() {
    if (this.#manualClose || this.#ws || this.#status === ConnectionStatus.REPLACED) return;
    this.#clearReconnect();
    this.#connect();
  }

  /** Closes for good; no reconnection. */
  close() {
    this.#manualClose = true;
    this.#clearReconnect();
    this.#stopHeartbeat();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      this.#detach(ws);
      try {
        ws.close(CloseCode.NORMAL, 'Bye');
      } catch {
        /* already closed */
      }
    }
    this.#setStatus(ConnectionStatus.CLOSED);
  }

  /** @param {object} message @returns {boolean} false if not connected */
  send(message) {
    if (!this.#ws || this.#ws.readyState !== OPEN_STATE) return false;
    try {
      this.#ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  #connect() {
    this.#setStatus(this.#attempt === 0 ? ConnectionStatus.CONNECTING : ConnectionStatus.RECONNECTING);
    let ws;
    try {
      ws = new this.#opts.WebSocketImpl(this.#opts.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.#lastMessageAt = this.#opts.now();
      this.#startHeartbeat();
      this.#setStatus(ConnectionStatus.OPEN);
    };
    ws.onmessage = (/** @type {{ data: unknown }} */ event) => {
      this.#lastMessageAt = this.#opts.now();
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) {
        console.warn('Ignoring malformed server message:', parsed.error);
        return;
      }
      for (const fn of [...this.#messageListeners]) {
        try {
          fn(parsed.message);
        } catch (err) {
          console.error('Message handler failed', err);
        }
      }
    };
    ws.onerror = () => {
      /* a close event always follows */
    };
    ws.onclose = (/** @type {{ code: number }} */ event) => this.#handleClose(ws, event.code);
  }

  /** @param {any} ws @param {number} code */
  #handleClose(ws, code) {
    if (ws !== this.#ws) return;
    this.#detach(ws);
    this.#ws = null;
    this.#stopHeartbeat();
    if (this.#manualClose) return;
    const fatal = FATAL_CODES.get(code);
    if (fatal) {
      this.#setStatus(fatal);
      return;
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#attempt >= this.#opts.maxAttempts) {
      this.#setStatus(ConnectionStatus.FAILED);
      return;
    }
    const { initialDelayMs, maxDelayMs, random } = this.#opts;
    const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** this.#attempt) * (0.8 + random() * 0.4);
    this.#attempt += 1;
    this.#setStatus(ConnectionStatus.RECONNECTING);
    this.#reconnectTimer = this.#opts.timers.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #clearReconnect() {
    if (this.#reconnectTimer !== null) this.#opts.timers.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.#heartbeatTimer = this.#opts.timers.setInterval(() => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== OPEN_STATE) return;
      if (this.#opts.now() - this.#lastMessageAt > this.#opts.staleAfterMs) {
        // No traffic at all (not even pongs): assume the connection is dead.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this.#handleClose(ws, 4_999);
        return;
      }
      this.send({ type: 'ping' });
    }, this.#opts.heartbeatMs);
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer !== null) this.#opts.timers.clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  /** @param {any} ws */
  #detach(ws) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  }

  /** @param {Status} status */
  #setStatus(status) {
    if (status === this.#status) return;
    this.#status = status;
    for (const fn of [...this.#statusListeners]) {
      try {
        fn(status);
      } catch (err) {
        console.error('Status handler failed', err);
      }
    }
  }
}
