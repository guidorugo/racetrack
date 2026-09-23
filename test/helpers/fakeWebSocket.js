/** A scriptable stand-in for the browser WebSocket, for client tests. */
export class FakeWebSocket {
  /** @type {FakeWebSocket[]} */
  static instances = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  static get last() {
    return FakeWebSocket.instances.at(-1);
  }

  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    /** @type {any[]} */
    this.sent = [];
    /** @type {number | null} */
    this.closedWith = null;
    /** @type {null | (() => void)} */ this.onopen = null;
    /** @type {null | ((e: { data: string }) => void)} */ this.onmessage = null;
    /** @type {null | ((e: { code: number }) => void)} */ this.onclose = null;
    /** @type {null | (() => void)} */ this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  /** @param {string} data */
  send(data) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(JSON.parse(data));
  }

  /** @param {number} [code] */
  close(code) {
    this.readyState = 3;
    this.closedWith = code ?? 1005;
  }

  // --- test controls ---

  serverOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  /** @param {object | string} message */
  serverSend(message) {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  /** @param {number} [code] */
  serverClose(code = 1006) {
    this.readyState = 3;
    this.onerror?.();
    this.onclose?.({ code });
  }

  /** @param {string} type */
  sentOfType(type) {
    return this.sent.filter((m) => m.type === type);
  }
}
