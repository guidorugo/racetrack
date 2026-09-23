/**
 * Minimal Chrome DevTools Protocol client for the end-to-end tests.
 * Zero dependencies: uses Node's built-in fetch and WebSocket (Node >= 22).
 */

import { lookup } from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';

export class Browser {
  /** @type {WebSocket} */
  #ws;
  #nextId = 1;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  #pending = new Map();
  /** @type {Set<(msg: any) => void>} */
  #listeners = new Set();

  /**
   * @param {string} endpoint  e.g. http://chrome:9222
   */
  static async connect(endpoint) {
    // Chrome only answers DevTools HTTP requests addressed to an IP or "localhost".
    const url = new URL(endpoint);
    if (url.hostname !== 'localhost' && !/^[\d.]+$/.test(url.hostname)) {
      url.hostname = (await lookup(url.hostname, { family: 4 })).address;
    }
    let version;
    for (let attempt = 0; ; attempt++) {
      try {
        version = await (await fetch(new URL('/json/version', url))).json();
        break;
      } catch (err) {
        if (attempt > 40) throw new Error(`Chrome is not reachable at ${url}: ${err}`);
        await sleep(250);
      }
    }
    const browser = new Browser(new WebSocket(version.webSocketDebuggerUrl));
    await new Promise((resolve, reject) => {
      browser.#ws.addEventListener('open', resolve, { once: true });
      browser.#ws.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
    });
    return browser;
  }

  /** @param {WebSocket} ws */
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.#pending.has(msg.id)) {
        const { resolve, reject } = /** @type {any} */ (this.#pending.get(msg.id));
        this.#pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else {
        for (const fn of this.#listeners) fn(msg);
      }
    });
  }

  /** @param {string} method @param {object} [params] @param {string} [sessionId] */
  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** @param {(msg: any) => void} fn */
  onEvent(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /**
   * Opens a new tab in a fresh browser context (separate storage), sized like a laptop screen.
   * `languages` is what the tab reports as the user's preferred languages (navigator.languages
   * and Accept-Language), so the page language never depends on the machine running the tests.
   */
  async newPage({ width = 1400, height = 900, languages = 'en-US,en' } = {}) {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId);
    await page.init(width, height, languages);
    return page;
  }

  close() {
    this.#ws.close();
  }
}

export class Page {
  /** @type {string[]} */
  errors = [];

  /** @param {Browser} browser @param {string} sessionId */
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
    browser.onEvent((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(`exception: ${d.exception?.description ?? d.text}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(`console.error: ${msg.params.args.map((/** @type {any} */ a) => a.value ?? a.description).join(' ')}`);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
      }
    });
  }

  /** @param {string} method @param {object} [params] */
  send(method, params) {
    return this.browser.send(method, params, this.sessionId);
  }

  /** @param {number} width @param {number} height @param {string} languages e.g. "pt-BR,pt" */
  async init(width, height, languages) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const { userAgent } = await this.browser.send('Browser.getVersion');
    await this.send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: languages });
  }

  /** @param {string} url */
  async goto(url) {
    const loaded = new Promise((resolve) => {
      const off = this.browser.onEvent((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === 'Page.loadEventFired') {
          off();
          resolve(undefined);
        }
      });
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /**
   * Evaluates an expression (or async function body) in the page and returns the value.
   * @param {string | Function} fn  a function is serialised and called with `args`
   * @param {...any} args
   */
  async eval(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`Evaluation failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  }

  /**
   * Polls until `fn` returns a truthy value.
   * @param {string | Function} fn @param {{ timeout?: number, interval?: number, message?: string }} [options] @param {...any} args
   */
  async waitFor(fn, { timeout = 10_000, interval = 100, message = String(fn) } = {}, ...args) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await this.eval(fn, ...args);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${message}`);
      await sleep(interval);
    }
  }

  /** @param {string} selector */
  async click(selector) {
    const ok = await this.eval((sel) => {
      const el = /** @type {HTMLElement | null} */ (document.querySelector(sel));
      if (!el) return false;
      el.click();
      return true;
    }, selector);
    if (!ok) throw new Error(`No element matches ${selector}`);
  }

  /** Real mouse click at page coordinates. @param {number} x @param {number} y */
  async mouseClick(x, y) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }

  /** @param {string} key e.g. "7" or "q" @param {string} [code] */
  async press(key, code = key.length === 1 && /\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  }

  /** Holds a key long enough for the keyboard to auto-repeat it `repeats` times. @param {string} key */
  async hold(key, repeats = 3) {
    const code = /\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key });
    for (let i = 0; i < repeats; i++) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key, autoRepeat: true });
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  }

  /** @param {string} selector @param {string} value */
  async type(selector, value) {
    await this.eval(
      (sel, val) => {
        const input = /** @type {HTMLInputElement} */ (document.querySelector(sel));
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      selector,
      value,
    );
  }

  /** @param {string} path */
  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    try {
      await writeFile(path, Buffer.from(data, 'base64'));
    } catch (err) {
      // Screenshots are a debugging aid; an unwritable folder must not fail the run.
      console.warn(`Could not save screenshot ${path}: ${/** @type {Error} */ (err).message}`);
    }
  }
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
