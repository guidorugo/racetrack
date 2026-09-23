/**
 * End-to-end browser tests: drives a real headless Chromium through all three
 * game modes and the language switcher, and fails on any broken flow or any
 * error in the browser console.
 *
 * Run with Docker (no local installs needed):
 *   docker compose --profile e2e up --build --abort-on-container-exit --exit-code-from e2e
 *
 * Environment:
 *   APP_URL      URL of the game as seen from the browser  (default http://racetrack:8080)
 *   CDP_URL      Chrome DevTools endpoint                   (default http://chrome:9222)
 *   RESULTS_DIR  where screenshots are written              (default test-results)
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Browser, sleep } from './cdp.js';

const APP_URL = process.env.APP_URL ?? 'http://racetrack:8080';
const CDP_URL = process.env.CDP_URL ?? 'http://chrome:9222';
const RESULTS_DIR = process.env.RESULTS_DIR ?? 'test-results';

/** @type {{ name: string, ok: boolean, error?: string, ms: number }[]} */
const results = [];

/** @param {string} name */
const shot = (name) => path.join(RESULTS_DIR, `${name}.png`);

/**
 * @param {string} name
 * @param {(browser: Browser) => Promise<import('./cdp.js').Page[]>} fn  returns the pages to check for errors
 */
async function scenario(name, browser, fn) {
  const started = Date.now();
  process.stdout.write(`▶ ${name}\n`);
  try {
    const pages = await fn(browser);
    const errors = pages.flatMap((p) => p.errors);
    if (errors.length) throw new Error(`browser errors:\n    ${errors.join('\n    ')}`);
    results.push({ name, ok: true, ms: Date.now() - started });
    process.stdout.write(`  ✔ passed (${Date.now() - started} ms)\n`);
  } catch (err) {
    results.push({ name, ok: false, error: String(/** @type {Error} */ (err).stack ?? err), ms: Date.now() - started });
    process.stdout.write(`  ✖ FAILED: ${/** @type {Error} */ (err).message}\n`);
  }
}

/** @param {unknown} condition @param {string} message */
function check(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

// --- In-page helpers (serialised into the browser) --------------------------------------

/** Snapshot of what the HUD shows. */
const readHud = () => {
  const text = (/** @type {string} */ sel) => document.querySelector(sel)?.textContent?.trim() ?? '';
  const current = document.querySelector('[data-standings] tr.is-current');
  const cells = current ? [...current.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '') : [];
  return {
    screen: [...document.querySelectorAll('main > .screen')].find((s) => !(/** @type {HTMLElement} */ (s)).hidden)?.id ?? null,
    turn: text('[data-turn-text]'),
    status: text('[data-turn-status]'),
    round: text('[data-round]'),
    rows: [...document.querySelectorAll('[data-standings] tr')].map((tr) => tr.textContent?.trim()),
    current: cells.length ? { name: cells[1], pos: cells[2], vel: cells[3] } : null,
    pad: [...document.querySelectorAll('[data-move-pad] button')].map((b) => ({
      enabled: !(/** @type {HTMLButtonElement} */ (b)).disabled,
      outcome: ['move', 'crash', 'win'].find((o) => b.classList.contains(`opt-${o}`)) ?? null,
      pending: b.classList.contains('is-pending'),
    })),
    log: [...document.querySelectorAll('[data-log] li')].map((li) => li.textContent?.trim()),
    gameOver: /** @type {HTMLDialogElement} */ (document.querySelector('#dialog-gameover')).open,
    gameOverTitle: text('[data-gameover-title]'),
    banner: /** @type {HTMLElement} */ (document.querySelector('[data-banner]')).hidden ? '' : text('[data-banner]'),
  };
};

/** Picks a pad button: a winning move if any, else a random safe one, else (all crash) the centre. */
const choosePadIndex = (/** @type {number} */ seed) => {
  const buttons = [...document.querySelectorAll('[data-move-pad] button')];
  if (buttons.some((b) => (/** @type {HTMLButtonElement} */ (b)).disabled)) return -1;
  const win = buttons.findIndex((b) => b.classList.contains('opt-win'));
  if (win >= 0) return win;
  const safe = buttons.map((b, i) => (b.classList.contains('opt-move') ? i : -1)).filter((i) => i >= 0);
  // Prefer moves that keep some speed ahead: indices sorted by a deterministic shuffle.
  if (safe.length) return safe[seed % safe.length];
  return 4;
};

/** Clicks the move-pad button with the given index (twice for crash moves, to confirm). */
async function playPad(page, index) {
  await page.click(`[data-move-pad] button[data-index="${index}"]`);
  const pending = await page.eval((i) => document.querySelector(`[data-move-pad] button[data-index="${i}"]`)?.classList.contains('is-pending'), index);
  if (pending) await page.click(`[data-move-pad] button[data-index="${index}"]`);
}

/** Screen coordinates (page space) of the grid point the given acceleration leads to. */
const optionScreenPoint = async (/** @type {number} */ ax, /** @type {number} */ ay) => {
  const { computeViewport, toScreen } = await import('/client/js/viewport.js');
  const { getTrack } = await import('/shared/tracks/index.js');
  const row = document.querySelector('[data-standings] tr.is-current');
  if (!row) return null;
  const cells = [...row.querySelectorAll('td')].map((td) => td.textContent ?? '');
  const [px, py] = (cells[2].match(/-?\d+/g) ?? []).map(Number);
  const [vx, vy] = (cells[3].match(/-?\d+/g) ?? []).map(Number);
  const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#board-canvas'));
  const rect = canvas.getBoundingClientRect();
  const track = getTrack('oval');
  const vp = computeViewport(Math.round(rect.width), Math.round(rect.height), track.width, track.height, 1.2);
  const p = toScreen(vp, px + vx + ax, py + vy + ay);
  return { x: rect.left + p.x, y: rect.top + p.y };
};

/** Picks a language in the header's language menu. */
const pickLanguage = (/** @type {string} */ code) => {
  const picker = /** @type {HTMLSelectElement} */ (document.querySelector('#language-select'));
  picker.value = code;
  picker.dispatchEvent(new Event('change'));
};

/**
 * Lists what on screen is not in the given language: page text that differs from the
 * catalog, message keys or unfilled {placeholders} left visible, a wrong <html lang>.
 */
const untranslated = async (/** @type {string} */ code) => {
  const { default: catalog } = await import(`/client/js/locales/${code}.js`);
  const problems = [];
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.getAttribute('data-i18n') ?? '';
    if (node.textContent !== catalog[key]) problems.push(`${key} reads "${node.textContent}"`);
  }
  for (const node of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of (node.getAttribute('data-i18n-attr') ?? '').split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (node.getAttribute(attr) !== catalog[key]) problems.push(`${key} (${attr}) reads "${node.getAttribute(attr)}"`);
    }
  }
  const text = document.body.innerText;
  problems.push(...Object.keys(catalog).filter((key) => text.includes(key)).map((key) => `raw key ${key} on screen`));
  problems.push(...(text.match(/\{\w+\}/g) ?? []).map((p) => `unfilled ${p} on screen`));
  if (document.documentElement.lang !== code) problems.push(`<html lang="${document.documentElement.lang}">`);
  if (document.title !== catalog['app.title']) problems.push(`title "${document.title}"`);
  return problems;
};

// --- Scenarios ------------------------------------------------------------------------------

async function singlePlayer(browser) {
  const page = await browser.newPage();
  await page.goto(APP_URL);
  await page.waitFor(() => !document.querySelector('#screen-menu').hidden, { message: 'main menu' });
  await page.screenshot(shot('01-menu'));

  await page.click('[data-action="single"]');
  await page.type('#form-single input[name="name"]', '');
  await page.click('#form-single button[type="submit"]');
  const error = await page.eval(() => document.querySelector('#form-single .form-error')?.textContent);
  check(/name/i.test(error ?? ''), 'an empty name is rejected with a message');

  await page.type('#form-single input[name="name"]', 'Tester');
  await page.click('#form-single button[type="submit"]');
  await page.waitFor(() => !document.querySelector('#screen-game').hidden, { message: 'game screen' });
  await page.eval(() => {
    const s = /** @type {HTMLSelectElement} */ (document.querySelector('[data-bot-speed]'));
    s.value = '120';
    s.dispatchEvent(new Event('change'));
  });
  let hud = await page.waitFor(readHud);
  check(hud.rows.length === 4, 'four drivers in the standings');
  check(hud.turn === "Tester's turn", `human moves first (got "${hud.turn}")`);
  check(hud.pad.every((b) => b.enabled), 'all nine move buttons are enabled on your turn');
  await sleep(400);
  await page.screenshot(shot('02-single-start'));

  // First move: click on the canvas (accelerate right).
  const point = await page.eval(optionScreenPoint, 1, 0);
  await page.mouseClick(point.x, point.y);
  await page.waitFor(() => document.querySelectorAll('[data-log] li').length >= 1, { message: 'first move logged' });
  hud = await page.eval(readHud);
  check(hud.log.at(-1).includes('Tester → (31, 28)'), `canvas click moved the car right (log: ${hud.log.at(-1)})`);

  // Play on until somebody wins.
  let moves = 1;
  for (let i = 0; i < 400; i++) {
    hud = await page.eval(readHud);
    if (hud.gameOver) break;
    if (hud.pad[0].enabled && hud.turn === "Tester's turn") {
      const index = await page.eval(choosePadIndex, i);
      if (index >= 0) {
        await playPad(page, index);
        moves++;
        if (moves === 8) await page.screenshot(shot('03-single-racing'));
      }
    }
    await sleep(150);
  }
  hud = await page.waitFor(readHud, { message: 'game over' });
  check(hud.gameOver, 'the race finishes and the result dialog opens');
  check(/wins!/.test(hud.gameOverTitle), `result title names the winner (${hud.gameOverTitle})`);
  await page.screenshot(shot('04-single-finished'));

  // The result dialog follows a language change, then comes back in English.
  const resultTexts = () => ({
    title: document.querySelector('[data-gameover-title]')?.textContent ?? '',
    actions: [...document.querySelectorAll('[data-gameover-actions] button')].map((b) => b.textContent),
    header: [...document.querySelectorAll('#dialog-gameover th')].map((th) => th.textContent),
  });
  await page.eval(pickLanguage, 'es');
  const es = await page.eval(resultTexts);
  check(/gana!/.test(es.title) && es.actions.includes('Otra carrera') && es.header.includes('Choques'), `result dialog in Spanish (${JSON.stringify(es)})`);
  await page.eval(pickLanguage, 'en');
  const en = await page.eval(resultTexts);
  check(/wins!/.test(en.title) && en.actions.includes('Race again'), `result dialog back in English (${JSON.stringify(en)})`);

  // Race again resets the board.
  await page.eval(() => [...document.querySelectorAll('[data-gameover-actions] button')].find((b) => b.textContent === 'Race again')?.click());
  await page.waitFor(() => document.querySelector('[data-round]')?.textContent === 'Round 1' && !document.querySelector('#dialog-gameover').open, { message: 'rematch' });
  check((await page.eval(readHud)).log.length === 0, 'log cleared for the new race');

  // Leaving asks for confirmation mid-race.
  await page.click('[data-action="leave-game"]');
  await page.waitFor(() => document.querySelector('#dialog-confirm').open, { message: 'confirm dialog' });
  await page.click('#dialog-confirm [value="ok"]');
  await page.waitFor(() => !document.querySelector('#screen-menu').hidden, { message: 'back at the menu' });
  return [page];
}

async function hotSeat(browser) {
  const page = await browser.newPage();
  await page.goto(APP_URL);
  await page.click('[data-action="local"]');
  await page.eval(() => {
    const slots = [...document.querySelectorAll('#local-slots .slot')];
    const set = (/** @type {Element} */ slot, /** @type {string} */ kind, /** @type {string} */ name, level = 'hard') => {
      const k = /** @type {HTMLSelectElement} */ (slot.querySelector('select[name="kind"]'));
      k.value = kind;
      k.dispatchEvent(new Event('change'));
      const input = /** @type {HTMLInputElement} */ (slot.querySelector('input[name="name"]'));
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true })); // typed by hand: later changes must not rename it
      /** @type {HTMLSelectElement} */ (slot.querySelector('select[name="level"]')).value = level;
    };
    set(slots[0], 'human', 'Alice');
    set(slots[1], 'human', 'Bob');
    set(slots[2], 'bot', 'Robo');
    set(slots[3], 'none', '');
  });
  await page.screenshot(shot('05-local-setup'));
  await page.click('#form-local button[type="submit"]');
  await page.waitFor(() => !document.querySelector('#screen-game').hidden, { message: 'game screen' });
  let hud = await page.waitFor(readHud);
  check(hud.turn === "Alice's turn", `Alice starts (got "${hud.turn}")`);
  check(hud.banner === "Alice's turn", `hot-seat banner announces Alice (got "${hud.banner}")`);

  // Alice tries to go up into the island wall: the first press only asks for confirmation.
  await page.press('w');
  hud = await page.eval(readHud);
  check(hud.pad[1].outcome === 'crash' && hud.pad[1].pending, 'crash move awaits confirmation');
  check(hud.turn === "Alice's turn" && hud.log.length === 0, 'nothing happened yet');
  await page.press('w');
  await page.waitFor(() => document.querySelectorAll('[data-log] li').length === 1, { message: 'crash applied' });
  hud = await page.eval(readHud);
  check(/Alice crashes into the wall/.test(hud.log[0]), `crash logged (${hud.log[0]})`);
  check(hud.turn === "Bob's turn", 'the crash ended Alice\'s turn');

  // Bob moves with the numpad key for "right".
  await sleep(350);
  await page.press('6');
  await page.waitFor(() => document.querySelectorAll('[data-log] li').length >= 2, { message: 'Bob moved' });
  // The bot moves by itself, then it is Alice's turn again.
  await page.waitFor(() => document.querySelector('[data-turn-text]')?.textContent === "Alice's turn" && document.querySelectorAll('[data-log] li').length >= 3, { message: 'bot moved, back to Alice' });
  hud = await page.eval(readHud);
  check(/Robo/.test(hud.log[0]), `bot move logged (${hud.log[0]})`);
  check(hud.round === 'Round 2', `round advanced (${hud.round})`);
  await sleep(350);
  await page.screenshot(shot('06-local-round2'));

  // Holding a key down (keyboard auto-repeat) must not also play Bob's move.
  const before = hud.log.length;
  await page.hold('d', 4);
  await sleep(200);
  hud = await page.eval(readHud);
  check(hud.log.length === before + 1, `one held key made exactly one move (${hud.log.length - before})`);
  check(hud.turn === "Bob's turn", `Bob still has his turn (${hud.turn})`);
  return [page];
}

async function online(browser) {
  const host = await browser.newPage();
  await host.goto(APP_URL);
  await host.click('[data-action="online"]');
  await host.waitFor(() => document.querySelector('[data-conn-text]')?.textContent?.startsWith('Connected'), { message: 'connected' });
  await host.type('#online-name', 'Hosty');
  await host.eval(() => {
    /** @type {HTMLSelectElement} */ (document.querySelector('#form-create select[name="turnTimeLimit"]')).value = '0';
  });
  await host.click('#form-create button[type="submit"]');
  await host.waitFor(() => !document.querySelector('#screen-lobby').hidden, { message: 'host in lobby' });
  const code = await host.eval(() => document.querySelector('[data-room-code]')?.textContent);
  check(/^[A-Z2-9]{5}$/.test(code), `room code shown (${code})`);

  const guest = await browser.newPage();
  await guest.goto(`${APP_URL}/?room=${code}`);
  await guest.waitFor(() => !document.querySelector('#screen-online').hidden, { message: 'invite link opens the online screen' });
  check((await guest.eval(() => /** @type {HTMLInputElement} */ (document.querySelector('#form-join input[name="code"]')).value)) === code, 'code prefilled from the invite link');
  await guest.type('#online-name', 'Guesty');
  await guest.click('#form-join button[type="submit"]');
  await guest.waitFor(() => !document.querySelector('#screen-lobby').hidden, { message: 'guest in lobby' });
  await host.waitFor(() => document.querySelectorAll('[data-seat-list] .seat:not(.is-open)').length === 2, { message: 'host sees the guest' });
  check(await guest.eval(() => document.querySelector('#screen-lobby').classList.contains('screen-lobby-guest')), 'guest has no host controls');

  await host.click('[data-action="add-bot"]');
  await guest.waitFor(() => document.querySelectorAll('[data-seat-list] .seat:not(.is-open)').length === 3, { message: 'guest sees the bot' });
  await host.screenshot(shot('07-online-lobby'));
  await host.click('[data-action="start-online"]');
  await host.waitFor(() => !document.querySelector('#screen-game').hidden, { message: 'host in race' });
  await guest.waitFor(() => !document.querySelector('#screen-game').hidden, { message: 'guest in race' });

  let h = await host.waitFor(readHud);
  let g = await guest.eval(readHud);
  check(h.turn === 'Your turn' && g.turn === "Hosty's turn", `turn shown correctly on both sides (${h.turn} / ${g.turn})`);
  check(g.pad.every((b) => !b.enabled), 'guest cannot move on the host\'s turn');

  await sleep(300);
  await host.press('d');
  await guest.waitFor(() => document.querySelector('[data-turn-text]')?.textContent === 'Your turn', { message: 'guest turn' });
  await sleep(350);
  await guest.press('d');
  await host.waitFor(() => document.querySelectorAll('[data-log] li').length >= 3, { message: 'bot moved on host screen' });
  await guest.waitFor(() => document.querySelectorAll('[data-log] li').length >= 3, { message: 'bot moved on guest screen' });
  await sleep(400);
  h = await host.eval(readHud);
  g = await guest.eval(readHud);
  const whoseTurn = (/** @type {string} */ turn, /** @type {string} */ me) => turn.replace('Your turn', `${me}'s turn`);
  check(h.round === g.round && whoseTurn(h.turn, 'Hosty') === whoseTurn(g.turn, 'Guesty'), `same round and turn on both screens (${h.round}/${h.turn} vs ${g.round}/${g.turn})`);
  const positions = (/** @type {any} */ hud) => hud.rows.map((r) => (r.match(/\(-?\d+, -?\d+\)/g) ?? []).join());
  check(JSON.stringify(positions(h)) === JSON.stringify(positions(g)), `identical positions on both screens (${positions(h)} vs ${positions(g)})`);
  await host.screenshot(shot('08-online-host'));
  await guest.screenshot(shot('09-online-guest'));

  // A reload rejoins the same seat.
  await guest.goto(`${APP_URL}/`);
  await guest.waitFor(() => !document.querySelector('#screen-game').hidden, { message: 'guest back in the race after reload', timeout: 15_000 });
  g = await guest.waitFor(readHud);
  check(g.rows.some((r) => /Guesty.*you/.test(r)), 'guest still owns their car after the reload');

  // The guest leaves; the host sees their car retired.
  await guest.click('[data-action="leave-game"]');
  await guest.waitFor(() => document.querySelector('#dialog-confirm').open, { message: 'leave confirmation' });
  await guest.click('#dialog-confirm [value="ok"]');
  await guest.waitFor(() => !document.querySelector('#screen-online').hidden, { message: 'guest back on the online screen' });
  await host.waitFor(() => [...document.querySelectorAll('[data-standings] tr')].some((tr) => /Guesty.*left/.test(tr.textContent ?? '')), { message: 'host sees the guest left' });
  return [host, guest];
}

async function languages(browser) {
  // A browser that prefers Brazilian Portuguese gets the game in Portuguese straight away.
  const page = await browser.newPage({ languages: 'pt-BR,pt;q=0.9,en;q=0.8' });
  await page.goto(APP_URL);
  await page.waitFor(() => !document.querySelector('#screen-menu').hidden, { message: 'main menu' });
  let problems = await page.eval(untranslated, 'pt');
  check(problems.length === 0, `menu in Portuguese: ${problems.join('; ')}`);
  check((await page.eval(() => /** @type {HTMLSelectElement} */ (document.querySelector('#language-select')).value)) === 'pt', 'the language menu shows Português');

  // ?lang= beats the browser preference, is remembered, and leaves the address bar.
  await page.goto(`${APP_URL}/?lang=es`);
  await page.waitFor(() => !document.querySelector('#screen-menu').hidden, { message: 'main menu (es)' });
  problems = await page.eval(untranslated, 'es');
  check(problems.length === 0, `menu in Spanish: ${problems.join('; ')}`);
  check((await page.eval(() => location.search)) === '', 'the lang parameter is dropped from the URL');
  await page.screenshot(shot('12-language-menu-es'));

  // Form validation and the race itself speak Spanish.
  await page.click('[data-action="single"]');
  await page.type('#form-single input[name="name"]', '');
  await page.click('#form-single button[type="submit"]');
  const error = await page.eval(() => document.querySelector('#form-single .form-error')?.textContent);
  check(error === 'Escribe tu nombre.', `form error in Spanish (${error})`);
  await page.type('#form-single input[name="name"]', 'Ana');
  await page.click('#form-single button[type="submit"]');
  await page.waitFor(() => !document.querySelector('#screen-game').hidden, { message: 'game screen' });
  await page.eval(() => {
    const s = /** @type {HTMLSelectElement} */ (document.querySelector('[data-bot-speed]'));
    s.value = '120';
    s.dispatchEvent(new Event('change'));
  });
  let hud = await page.waitFor(readHud);
  check(hud.turn === 'Turno de Ana' && hud.round === 'Ronda 1', `HUD in Spanish (${hud.turn} / ${hud.round})`);
  await sleep(300);
  await page.press('d');
  await page.waitFor(() => document.querySelector('[data-turn-text]')?.textContent === 'Turno de Ana' && document.querySelectorAll('[data-log] li').length === 4, { message: 'the bots moved, back to Ana' });
  hud = await page.eval(readHud);
  check(hud.log.at(-1).endsWith('Ana → (31, 28), velocidad 1'), `race log in Spanish (${hud.log.at(-1)})`);

  // Switching language mid-race rewrites everything, the race log included.
  await page.eval(pickLanguage, 'it');
  hud = await page.eval(readHud);
  check(hud.turn === 'Tocca a Ana' && hud.round === 'Turno 2', `HUD switched to Italian (${hud.turn} / ${hud.round})`);
  check(hud.log.length === 4 && hud.log.at(-1).endsWith('Ana → (31, 28), velocità 1'), `race log switched to Italian (${hud.log.at(-1)})`);
  const padLabel = await page.eval(() => document.querySelector('[data-move-pad] button[data-index="5"]')?.getAttribute('aria-label'));
  check(padLabel?.startsWith('destra:'), `move buttons relabelled (${padLabel})`);
  problems = await page.eval(untranslated, 'it');
  check(problems.length === 0, `race screen in Italian: ${problems.join('; ')}`);
  await sleep(300);
  await page.screenshot(shot('13-language-race-it'));
  await page.press('d');
  await page.waitFor(() => document.querySelectorAll('[data-log] li').length >= 5, { message: 'the race goes on after the switch' });

  // The choice survives a reload.
  await page.goto(APP_URL);
  await page.waitFor(() => !document.querySelector('#screen-menu').hidden, { message: 'main menu after reload' });
  problems = await page.eval(untranslated, 'it');
  check(problems.length === 0, `still Italian after a reload: ${problems.join('; ')}`);

  // Server errors arrive in the player's language.
  await page.click('[data-action="online"]');
  await page.waitFor(() => document.querySelector('[data-conn-text]')?.textContent?.startsWith('Connesso'), { message: 'connected (it)' });
  await page.type('#online-name', 'Ana');
  await page.type('#form-join input[name="code"]', 'ZZZZZ');
  await page.click('#form-join button[type="submit"]');
  await page.waitFor(() => document.querySelector('#screen-online .form-error')?.textContent === 'Questa stanza non esiste (o è stata chiusa).', { message: 'unknown room reported in Italian' });

  await page.eval(pickLanguage, 'en');
  problems = await page.eval(untranslated, 'en');
  check(problems.length === 0, `back in English: ${problems.join('; ')}`);
  const conn = await page.eval(() => document.querySelector('[data-conn-text]')?.textContent);
  check(conn?.startsWith('Connected'), `connection status follows the language (${conn})`);
  return [page];
}

async function mobile(browser) {
  const page = await browser.newPage({ width: 390, height: 844 });
  await page.goto(APP_URL);
  await page.click('[data-action="single"]');
  await page.type('#form-single input[name="name"]', 'Phone');
  await page.click('#form-single button[type="submit"]');
  await page.waitFor(() => !document.querySelector('#screen-game').hidden, { message: 'game screen' });
  await sleep(400);
  const overflow = await page.eval(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `no horizontal scrolling on a phone (overflow ${overflow}px)`);
  const canvas = await page.eval(() => {
    const r = document.querySelector('#board-canvas').getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  check(canvas.w > 300 && canvas.h > 180, `board is visible on a phone (${canvas.w}x${canvas.h})`);
  await page.screenshot(shot('10-mobile'));

  // A phone held sideways: the whole board must fit on screen.
  const landscape = await browser.newPage({ width: 844, height: 390 });
  await landscape.goto(APP_URL);
  await landscape.click('[data-action="single"]');
  await landscape.type('#form-single input[name="name"]', 'Sideways');
  await landscape.click('#form-single button[type="submit"]');
  await landscape.waitFor(() => !document.querySelector('#screen-game').hidden, { message: 'game screen (landscape)' });
  await sleep(300);
  const fits = await landscape.eval(() => {
    const r = document.querySelector('#board-canvas').getBoundingClientRect();
    return { bottom: Math.round(r.bottom + window.scrollY), height: window.innerHeight };
  });
  check(fits.bottom <= fits.height, `board fits a landscape phone screen (bottom ${fits.bottom} > ${fits.height})`);
  await landscape.screenshot(shot('11-mobile-landscape'));

  // Translations run longer than English: no screen may get wider than the phone.
  const pageOverflow = () => document.documentElement.scrollWidth - window.innerWidth;
  for (const code of ['es', 'pt', 'it']) {
    for (const action of ['single', 'local', 'online']) {
      await page.goto(`${APP_URL}/?lang=${code}`);
      await page.click(`[data-action="${action}"]`);
      await page.waitFor(() => document.querySelector('#screen-menu').hidden, { message: `${action} screen (${code})` });
      const px = await page.eval(pageOverflow);
      check(px <= 0, `no horizontal scrolling on the ${action} screen in ${code} (overflow ${px}px)`);
      await page.screenshot(shot(`14-mobile-${code}-${action}`));
    }
    await page.goto(`${APP_URL}/?lang=${code}`);
    await page.click('[data-action="single"]');
    await page.type('#form-single input[name="name"]', 'Phone');
    await page.click('#form-single button[type="submit"]');
    await page.waitFor(() => !document.querySelector('#screen-game').hidden, { message: `game screen (${code})` });
    await sleep(300);
    const px = await page.eval(pageOverflow);
    check(px <= 0, `no horizontal scrolling during a race in ${code} (overflow ${px}px)`);
    await page.screenshot(shot(`14-mobile-${code}-race`));
  }
  return [page, landscape];
}

// --- Main --------------------------------------------------------------------------------------

await mkdir(RESULTS_DIR, { recursive: true }).catch((err) => console.warn(`Cannot create ${RESULTS_DIR}: ${err.message}`));
const browser = await Browser.connect(CDP_URL);
for (const [name, fn] of [
  ['single player: full race against three bots', singlePlayer],
  ['local multiplayer: hot-seat turns, keyboard input and crash confirmation', hotSeat],
  ['online multiplayer: lobby, synchronised race, reload, leaving', online],
  ['languages: browser preference, ?lang=, switching mid-race, server errors', languages],
  ['mobile layout', mobile],
]) {
  await scenario(/** @type {string} */ (name), browser, /** @type {any} */ (fn));
}
browser.close();

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} scenarios passed. Screenshots: ${RESULTS_DIR}/\n`);
for (const f of failed) process.stdout.write(`\n✖ ${f.name}\n${f.error}\n`);
process.exit(failed.length ? 1 : 0);
