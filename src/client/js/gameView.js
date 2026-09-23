/**
 * The race screen: board canvas + HUD, wired to a game controller
 * (LocalController or OnlineGameController — same interface).
 *
 * Responsibilities: rendering the current state, animating the latest move,
 * turning clicks / taps / keys / move-pad presses into moves (with a
 * confirmation step for crashing moves), and showing whose turn it is, every
 * car's position and velocity, the race log and the final result.
 */

import { LETTER_KEYS, NUMPAD_KEYS } from '../../shared/constants.js';
import { getCurrentPlayer, getMoveOptions } from '../../shared/game.js';
import { computeStandings } from '../../shared/standings.js';
import { $, closeDialog, el, openDialog, swatch, toast } from './dom.js';
import {
  ARROWS,
  describeMove,
  describeOption,
  directionName,
  fmtPoint,
  fmtVector,
  levelLabel,
  ordinal,
  secondsLeft,
} from './format.js';
import { t, tn } from './i18n.js';
import { Renderer } from './renderer.js';
import { preferences } from './storage.js';
import { pickOption, pickRadius } from './viewport.js';

const ANIMATION_MS = 300;
/** How long a first pick of a crashing move (or a first tap on a small board) waits for confirmation. */
const CONFIRM_MS = 4_000;
const MAX_LOG_ENTRIES = 150;
/**
 * Below this many pixels per grid unit a pick on the board only selects, and a
 * second pick confirms: fingers need roomier spacing than a mouse does.
 */
const PRECISE_SCALE = { touch: 28, mouse: 10 };

/**
 * @typedef {import('../../shared/game.js').GameState} GameState
 * @typedef {import('../../shared/game.js').MoveOption} MoveOption
 * @typedef {import('../../shared/game.js').MoveRecord} MoveRecord
 * @typedef {{ label: string, primary?: boolean, onClick: () => void }} DialogAction
 *
 * @typedef {Object} GameViewHooks
 * @property {(controller: any) => DialogAction[]} gameOverActions
 * @property {(controller: any) => string} [gameOverHint]
 */

export class GameView {
  /** @type {any} */
  #controller = null;
  /** @type {(() => void) | null} */
  #unsubscribe = null;
  /** @type {GameState | null} */
  #state = null;
  /** @type {MoveOption[]} */
  #options = [];
  #hoverIndex = -1;
  #pendingIndex = -1;
  #pendingUntil = 0;
  /** @type {(import('./renderer.js').MoveAnimation & { start: number }) | null} */
  #anim = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #animTimer = null;
  #rafId = 0;
  #lastFrame = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  #ticker = null;
  /** @type {ResizeObserver | null} */
  #resizeObserver = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #bannerTimer = null;
  #gameOverShown = false;
  /** Signature of the result dialog's buttons, to refresh them only when they change. */
  #gameOverActionsKey = '';
  /** @type {string | null} */
  #lastTurnKey = null;
  /** Lap count per player as the race log was written (for "completes lap n"). */
  #logLaps = new Map();
  #coarsePointer = false;
  #abort = new AbortController();

  /**
   * @param {HTMLElement} root  the #screen-game section
   * @param {GameViewHooks} hooks
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.canvas = /** @type {HTMLCanvasElement} */ ($('#board-canvas', root));
    this.renderer = new Renderer(this.canvas);
    this.ui = {
      round: $('[data-round]', root),
      laps: $('[data-laps]', root),
      turnSwatch: $('[data-turn-swatch]', root),
      turnText: $('[data-turn-text]', root),
      turnStatus: $('[data-turn-status]', root),
      connStatus: $('[data-conn-status]', root),
      pad: $('[data-move-pad]', root),
      preview: $('[data-move-preview]', root),
      standings: $('[data-standings]', root),
      log: $('[data-log]', root),
      banner: $('[data-banner]', root),
      botSpeed: /** @type {HTMLSelectElement} */ ($('[data-bot-speed]', root)),
      resultsButton: /** @type {HTMLButtonElement} */ ($('[data-action="show-results"]', root)),
      lobbyButton: /** @type {HTMLButtonElement} */ ($('[data-action="to-lobby"]', root)),
    };
    this.gameOverDialog = /** @type {HTMLDialogElement} */ ($('#dialog-gameover'));
    this.padButtons = NUMPAD_KEYS.map((key, i) => {
      const button = el('button', { attrs: { type: 'button', 'data-index': String(i) } }, [
        el('span', { class: 'arrow', text: ARROWS[i], attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'key', text: `${key} · ${LETTER_KEYS[i].toUpperCase()}`, attrs: { 'aria-hidden': 'true' } }),
      ]);
      this.ui.pad.append(button);
      return /** @type {HTMLButtonElement} */ (button);
    });
  }

  /** @param {any} controller */
  mount(controller) {
    this.unmount();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;
    this.#controller = controller;
    this.root.classList.toggle('mode-online', controller.mode === 'online');
    this.#state = controller.getState();
    this.renderer.setTrack(controller.getTrack());
    this.#resetLog(this.#state);
    this.#gameOverShown = false;
    this.#lastTurnKey = null;
    this.#coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    closeDialog(this.gameOverDialog);

    this.#unsubscribe = controller.subscribe((/** @type {any} */ event) => this.#onEvent(event));

    this.canvas.addEventListener('pointermove', (e) => this.#onPointerMove(e), { signal });
    this.canvas.addEventListener('pointerleave', () => this.#setHover(-1), { signal });
    this.canvas.addEventListener('click', (e) => this.#onClick(e), { signal });
    document.addEventListener('keydown', (e) => this.#onKeyDown(e), { signal });
    this.ui.resultsButton.addEventListener('click', () => this.#showGameOver(true), { signal });
    this.padButtons.forEach((button, i) => {
      button.addEventListener('click', () => this.#choose(i, 'pad'), { signal });
      button.addEventListener('mouseenter', () => this.#setHover(i), { signal });
      button.addEventListener('mouseleave', () => this.#setHover(-1), { signal });
      button.addEventListener('focus', () => this.#setHover(i), { signal });
      button.addEventListener('blur', () => this.#setHover(-1), { signal });
    });
    if (controller.mode !== 'online') {
      const saved = Number(preferences.get('botSpeed', 450));
      if ([...this.ui.botSpeed.options].some((o) => Number(o.value) === saved)) this.ui.botSpeed.value = String(saved);
      controller.setBotDelay?.(Number(this.ui.botSpeed.value));
      this.ui.botSpeed.addEventListener('change', () => {
        controller.setBotDelay?.(Number(this.ui.botSpeed.value));
        preferences.set('botSpeed', Number(this.ui.botSpeed.value));
        this.ui.botSpeed.blur(); // hand the keyboard back to the game
      }, { signal });
    }

    this.#resizeObserver = new ResizeObserver(() => {
      if (this.renderer.resize()) this.#draw();
    });
    this.#resizeObserver.observe(this.canvas);
    this.#ticker = setInterval(() => this.#renderStatus(), 500);
    this.#rafId = requestAnimationFrame((t) => this.#frame(t));

    this.#refresh();
    controller.start?.();
  }

  unmount() {
    this.#abort.abort();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#controller = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
    if (this.#bannerTimer) clearTimeout(this.#bannerTimer);
    cancelAnimationFrame(this.#rafId);
    this.#cancelAnimation();
    this.#hoverIndex = -1;
    this.#pendingIndex = -1;
    this.#hideBanner();
    closeDialog(this.gameOverDialog);
  }

  get controller() {
    return this.#controller;
  }

  /** Re-renders every piece of text after the language changed. */
  refreshLanguage() {
    if (!this.#controller || !this.#state) return;
    this.#resetLog(this.#state);
    this.#lastTurnKey = `${this.#state.turn}:${getCurrentPlayer(this.#state)?.id ?? ''}`; // no banner replay
    if (this.gameOverDialog.open) this.#showGameOver(true);
    this.#refresh();
  }

  // --- Events --------------------------------------------------------------------------

  /** @param {any} event */
  #onEvent(event) {
    if (event.type === 'state') {
      this.#state = event.state;
      if (this.renderer.track?.id !== event.state.trackId) {
        this.renderer.setTrack(this.#controller.getTrack());
        this.renderer.resize();
      }
      if (event.reset) {
        this.#resetLog(event.state); // replays the history, e.g. after a reload
        this.#gameOverShown = false;
        this.#lastTurnKey = null;
        closeDialog(this.gameOverDialog);
        this.#cancelAnimation();
      }
      for (const move of event.moves) this.#appendLog(move, event.state);
      const last = event.moves.at(-1);
      if (last) {
        this.#startAnimation(last);
        this.#pendingIndex = -1;
      }
      // A snapshot without new moves (e.g. someone left) keeps any animation running.
      this.#refresh();
    } else if (event.type === 'error') {
      this.#pendingIndex = -1;
      toast(event.message, { type: 'error' });
      this.#refresh();
    } else if (event.type === 'meta') {
      this.#refresh();
    }
  }

  /** @param {PointerEvent} e */
  #onPointerMove(e) {
    // Options are hidden on the board while a move animates.
    if (!this.#options.length || !this.renderer.viewport || this.#anim) return this.#setHover(-1);
    const rect = this.canvas.getBoundingClientRect();
    const vp = this.renderer.viewport;
    const i = pickOption(vp, this.#options, e.clientX - rect.left, e.clientY - rect.top, pickRadius(vp));
    this.#setHover(i);
  }

  /** @param {MouseEvent} e */
  #onClick(e) {
    if (!this.#options.length || !this.renderer.viewport || this.#anim) return;
    const rect = this.canvas.getBoundingClientRect();
    const vp = this.renderer.viewport;
    const i = pickOption(vp, this.#options, e.clientX - rect.left, e.clientY - rect.top, pickRadius(vp) * 1.15);
    // On small boards and touch screens a stray tap can easily hit the wrong
    // point, so a tap there only selects; tapping the same point again confirms.
    const precise = vp.scale >= (this.#coarsePointer ? PRECISE_SCALE.touch : PRECISE_SCALE.mouse);
    if (i >= 0) this.#choose(i, precise ? 'pointer' : 'tap');
  }

  /** @param {KeyboardEvent} e */
  #onKeyDown(e) {
    if (this.root.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.repeat) return; // holding a key must not play the next player's move too
    if (document.querySelector('dialog[open]')) return;
    const target = /** @type {HTMLElement | null} */ (e.target);
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    if (e.key === 'Escape' && this.#pendingIndex >= 0) {
      this.#pendingIndex = -1;
      this.#refresh();
      return;
    }
    let index = -1;
    if (/^Numpad[1-9]$/.test(e.code)) index = NUMPAD_KEYS.indexOf(e.code.slice(-1));
    else if (/^[1-9]$/.test(e.key)) index = NUMPAD_KEYS.indexOf(e.key);
    else if (e.key.length === 1) index = LETTER_KEYS.indexOf(e.key.toLowerCase());
    if (index < 0) return;
    e.preventDefault();
    this.#choose(index);
  }

  /** @param {number} index */
  #setHover(index) {
    if (index === this.#hoverIndex) return;
    this.#hoverIndex = index;
    this.canvas.classList.toggle('over-option', index >= 0 && this.#options.length > 0);
    this.#renderPad();
    this.#renderPreview();
  }

  /**
   * @param {number} index
   * @param {'key' | 'pad' | 'pointer' | 'tap'} [source]  taps on small boards need confirming
   */
  #choose(index, source = 'key') {
    const controller = this.#controller;
    if (!controller || !controller.canMove()) return;
    // Choosing during an animation is fine: skip to its end instead of ignoring the input.
    if (this.#anim) this.#finishAnimation();
    const option = this.#options[index];
    if (!option) return;
    const now = performance.now();
    const needsConfirm = option.outcome === 'crash' || source === 'tap';
    if (needsConfirm && !(this.#pendingIndex === index && now < this.#pendingUntil)) {
      this.#pendingIndex = index;
      this.#pendingUntil = now + CONFIRM_MS;
      this.#renderPad();
      this.#renderPreview();
      return;
    }
    this.#pendingIndex = -1;
    controller.submitMove(option.acceleration);
  }

  // --- Rendering -------------------------------------------------------------------------

  /** Recomputes options and redraws everything after any change. */
  #refresh() {
    const state = this.#state;
    const controller = this.#controller;
    if (!state || !controller) return;
    this.#options = controller.canMove() ? getMoveOptions(state, controller.getTrack()) : [];
    if (!this.#options.length) {
      this.#hoverIndex = -1;
      this.#pendingIndex = -1;
    }
    this.canvas.classList.toggle('can-pick', this.#options.length > 0);
    this.#renderTurn();
    this.#renderStatus();
    this.#renderPad();
    this.#renderPreview();
    this.#renderStandings();
    this.#maybeAnnounceTurn();
    const finished = state.status === 'finished';
    this.ui.resultsButton.hidden = !finished;
    this.ui.lobbyButton.hidden = !finished;
    this.#draw();
    if (finished && !this.#anim) this.#showGameOver();
  }

  /** @param {number} now */
  #frame(now) {
    this.#rafId = requestAnimationFrame((t) => this.#frame(t));
    if (this.#anim) {
      this.#anim.t = Math.min(1, (now - this.#anim.start) / ANIMATION_MS);
      if (this.#anim.t >= 1) {
        this.#finishAnimation(); // options appear once the move has played out
        return;
      }
      this.#draw(now);
      return;
    }
    if (this.#pendingIndex >= 0 && now >= this.#pendingUntil) {
      this.#pendingIndex = -1;
      this.#renderPad();
      this.#renderPreview();
    }
    if (now - this.#lastFrame > 60) this.#draw(now); // gentle pulse of the current car
  }

  /** @param {MoveRecord} move */
  #startAnimation(move) {
    this.#cancelAnimation();
    this.#anim = {
      playerId: move.playerId,
      from: move.from,
      to: move.to,
      target: move.target,
      crash: move.outcome === 'crashed',
      t: 0,
      start: performance.now(),
    };
    // requestAnimationFrame does not run in background tabs, so make sure the
    // animation always ends (and the game carries on) even if no frame is drawn.
    this.#animTimer = setTimeout(() => this.#finishAnimation(), ANIMATION_MS + 50);
  }

  #finishAnimation() {
    const wasAnimating = this.#anim !== null;
    this.#cancelAnimation();
    if (wasAnimating) this.#refresh();
  }

  #cancelAnimation() {
    if (this.#animTimer) clearTimeout(this.#animTimer);
    this.#animTimer = null;
    this.#anim = null;
  }

  #draw(now = performance.now()) {
    this.#lastFrame = now;
    this.renderer.render({
      state: this.#state,
      options: this.#options,
      hoverIndex: this.#hoverIndex,
      pendingIndex: this.#pendingIndex,
      anim: this.#anim,
      localPlayerId: this.#controller?.getLocalPlayerId?.() ?? null,
      time: now,
    });
  }

  #renderTurn() {
    const state = /** @type {GameState} */ (this.#state);
    const controller = this.#controller;
    const current = getCurrentPlayer(state);
    const localId = controller.getLocalPlayerId?.() ?? null;
    this.ui.round.textContent = t('game.round', { n: state.round });
    const lapFor = current ?? state.players.find((p) => p.id === state.winnerId);
    this.ui.laps.textContent = state.laps > 1 && lapFor
      ? t('game.lapOf', { lap: Math.min(state.laps, Math.max(1, lapFor.lapProgress + 1)), laps: state.laps })
      : tn('game.laps', state.laps);
    if (state.status === 'finished') {
      const winner = state.players.find((p) => p.id === state.winnerId);
      this.ui.turnSwatch.style.backgroundColor = winner?.color ?? 'transparent';
      this.ui.turnText.textContent = winner
        ? winner.id === localId ? t('game.youWin') : t('game.playerWins', { name: winner.name })
        : t('game.raceOver');
      return;
    }
    if (!current) return;
    this.ui.turnSwatch.style.backgroundColor = current.color;
    if (current.id === localId) this.ui.turnText.textContent = t('game.yourTurn');
    else this.ui.turnText.textContent = t(current.kind === 'bot' ? 'game.playerTurnBot' : 'game.playerTurn', { name: current.name });
  }

  /** The status lines under the turn banner; also called every 500 ms for countdowns. */
  #renderStatus() {
    const state = this.#state;
    const controller = this.#controller;
    if (!state || !controller) return;
    const current = getCurrentPlayer(state);
    const meta = controller.mode === 'online' ? controller.getMeta() : null;
    const localId = controller.getLocalPlayerId?.() ?? null;
    let text = '';
    let urgent = false;

    if (state.status === 'finished') {
      text = state.endReason === 'round-limit' ? t('status.roundLimit') : state.endReason === 'all-retired' ? t('status.allLeft') : t('status.raceOver');
    } else if (current) {
      const seat = meta?.seats.find((/** @type {any} */ s) => s.playerId === current.id);
      const name = current.name;
      if (meta?.waitingFor && meta.waitingFor.playerId === current.id) {
        text = t('status.waitingReconnect', { name, seconds: secondsLeft(meta.waitingFor.until, Date.now()) });
      } else if (seat?.autopilot) {
        text = t('status.autopilot', { name });
      } else if (current.kind === 'bot') {
        text = t('status.botThinking', { name });
      } else if (meta?.moveInFlight) {
        text = t('status.sending');
      } else if (controller.canMove()) {
        const humans = state.players.filter((p) => p.kind === 'human' && p.status === 'racing').length;
        text = controller.mode === 'local' && humans > 1 ? t('status.pickNamed', { name }) : t('status.pick');
      } else if (current.id !== localId) {
        text = t('status.waitingFor', { name });
      }
      if (meta?.turnDeadline && !(meta.waitingFor && meta.waitingFor.playerId === current.id)) {
        const left = secondsLeft(meta.turnDeadline, Date.now());
        text += ` ${t('status.secondsLeft', { seconds: left })}`;
        urgent = current.id === localId && left <= 10;
      }
    }
    this.ui.turnStatus.textContent = text;
    this.ui.turnStatus.classList.toggle('is-urgent', urgent);

    if (meta) {
      const conn = meta.connection;
      const bad = conn !== 'open';
      this.ui.connStatus.hidden = !bad;
      this.ui.connStatus.textContent =
        conn === 'reconnecting' || conn === 'connecting' ? t('conn.reconnecting') : conn === 'failed' ? t('conn.failed') : conn === 'replaced' ? t('conn.replaced') : '';
      this.ui.connStatus.classList.toggle('is-urgent', bad);
      if (bad) this.#showBanner(this.ui.connStatus.textContent, { warning: true, sticky: true });
      else if (this.ui.banner.dataset.sticky === 'true') this.#hideBanner();
    }
  }

  #renderPad() {
    const canMove = this.#options.length > 0;
    this.padButtons.forEach((button, i) => {
      const option = this.#options[i];
      button.disabled = !canMove || !option;
      button.classList.remove('opt-move', 'opt-crash', 'opt-win');
      if (option) button.classList.add(`opt-${option.outcome}`);
      button.classList.toggle('is-hovered', i === this.#hoverIndex);
      button.classList.toggle('is-pending', i === this.#pendingIndex);
      const description = option ? describeOption(option) : '';
      button.setAttribute('aria-label', option ? t('pad.aria', { direction: directionName(i), description, key: NUMPAD_KEYS[i] }) : directionName(i));
      button.title = option ? describeOption(option) : '';
    });
  }

  #renderPreview() {
    const focus = this.#pendingIndex >= 0 ? this.#pendingIndex : this.#hoverIndex;
    const option = this.#options[focus];
    let text = '';
    if (this.#pendingIndex >= 0 && option) {
      text = t('preview.confirm', { option: describeOption(option) });
    } else if (option) {
      text = describeOption(option);
    } else if (this.#options.length && this.#options.every((o) => o.outcome === 'crash')) {
      text = t('preview.allCrash');
    } else if (this.#options.length) {
      const player = this.#state && getCurrentPlayer(this.#state);
      text = player ? t('preview.position', { pos: fmtPoint(player.position), vel: fmtVector(player.velocity) }) : '';
    }
    this.ui.preview.textContent = text || ' ';
  }

  #renderStandings() {
    const state = /** @type {GameState} */ (this.#state);
    const controller = this.#controller;
    const track = controller.getTrack();
    const meta = controller.mode === 'online' ? controller.getMeta() : null;
    const localId = controller.getLocalPlayerId?.() ?? null;
    const current = getCurrentPlayer(state);
    const rows = computeStandings(state, track).map((standing) => {
      const player = /** @type {any} */ (state.players.find((p) => p.id === standing.playerId));
      const seatIndex = state.players.indexOf(player);
      const seat = meta?.seats.find((/** @type {any} */ s) => s.playerId === player.id);
      const badges = [];
      if (player.id === localId) badges.push(el('span', { class: 'badge you', text: t('badge.you') }));
      if (player.kind === 'bot') badges.push(el('span', { class: 'badge', text: t('badge.bot', { level: levelLabel(player.botLevel) }) }));
      if (player.status === 'retired') badges.push(el('span', { class: 'badge warn', text: t('badge.left') }));
      else if (seat && !seat.connected) badges.push(el('span', { class: 'badge warn', text: t('badge.offline') }));
      if (seat?.autopilot && player.status !== 'retired') badges.push(el('span', { class: 'badge', text: t('badge.autopilot') }));
      const row = el('tr', {}, [
        el('td', { class: 'num', text: player.status === 'retired' ? '–' : ordinal(standing.rank) }),
        el('td', {}, [
          el('div', { class: 'driver' }, [
            swatch(player.color),
            el('div', { class: 'driver-text' }, [
              el('span', { class: 'driver-name', text: `${seatIndex + 1}. ${player.name}`, title: player.name }),
              badges.length ? el('span', { class: 'driver-badges' }, badges) : null,
            ]),
          ]),
        ]),
        el('td', { class: 'num', text: fmtPoint(player.position) }),
        el('td', { class: 'num', text: fmtVector(player.velocity) }),
        el('td', { class: 'num', text: String(player.crashes) }),
      ]);
      row.classList.toggle('is-current', player === current);
      row.classList.toggle('is-out', player.status === 'retired');
      return row;
    });
    this.ui.standings.replaceChildren(...rows);
  }

  /**
   * Clears the race log and rewrites it from the state's history (after a reload or a
   * language change). Only the newest entries are shown, but lap counts need every move.
   * @param {GameState | null} state
   */
  #resetLog(state) {
    this.ui.log.replaceChildren();
    this.#logLaps = new Map();
    if (!state) return;
    const firstShown = state.history.length - MAX_LOG_ENTRIES;
    state.history.forEach((move, i) => (i < firstShown ? this.#countLap(move) : this.#appendLog(move, state)));
  }

  /** Keeps each driver's lap count in step with the log. @param {MoveRecord} move */
  #countLap(move) {
    const lap = (this.#logLaps.get(move.playerId) ?? 0) + move.lapDelta;
    this.#logLaps.set(move.playerId, lap);
    return lap;
  }

  /** @param {MoveRecord} move @param {GameState} state */
  #appendLog(move, state) {
    const lap = this.#countLap(move);
    const player = state.players.find((p) => p.id === move.playerId);
    if (!player) return;
    const item = el('li', { class: move.outcome === 'crashed' ? 'is-crash' : move.outcome === 'won' ? 'is-win' : '' }, [
      el('span', { class: 'round-tag', text: t('game.roundTag', { n: move.round }) }),
      swatch(player.color),
      el('span', { text: describeMove(move, player.name, { laps: state.laps, lapProgress: lap }) }),
    ]);
    this.ui.log.prepend(item);
    while (this.ui.log.children.length > MAX_LOG_ENTRIES) this.ui.log.lastElementChild?.remove();
  }

  /** In hot-seat games, flash whose turn it is so players know when to swap. */
  #maybeAnnounceTurn() {
    const state = this.#state;
    const controller = this.#controller;
    if (!state || !controller || state.status !== 'playing') return;
    const current = getCurrentPlayer(state);
    if (!current) return;
    const key = `${state.turn}:${current.id}`;
    if (key === this.#lastTurnKey) return;
    this.#lastTurnKey = key;
    const humans = state.players.filter((p) => p.kind === 'human' && p.status === 'racing').length;
    if (controller.mode === 'local' && humans > 1 && current.kind === 'human') {
      this.#showBanner(t('game.playerTurn', { name: current.name }));
    } else if (controller.mode === 'online' && current.id === controller.getLocalPlayerId()) {
      this.#showBanner(t('game.bannerYourTurn'));
    }
  }

  /** @param {string} text @param {{ warning?: boolean, sticky?: boolean }} [options] */
  #showBanner(text, { warning = false, sticky = false } = {}) {
    const banner = this.ui.banner;
    if (banner.dataset.sticky === 'true' && !sticky) return; // don't hide connection warnings
    banner.textContent = text;
    banner.classList.toggle('is-warning', warning);
    banner.dataset.sticky = String(sticky);
    banner.hidden = false;
    if (this.#bannerTimer) clearTimeout(this.#bannerTimer);
    this.#bannerTimer = sticky ? null : setTimeout(() => this.#hideBanner(), 1_600);
  }

  #hideBanner() {
    this.ui.banner.hidden = true;
    this.ui.banner.dataset.sticky = 'false';
  }

  /** @param {boolean} [reopen] show it again after the player dismissed it */
  #showGameOver(reopen = false) {
    if (this.#gameOverShown && !reopen) {
      if (this.gameOverDialog.open) this.#renderGameOverActions(); // e.g. the host changed
      return;
    }
    this.#gameOverShown = true;
    const state = /** @type {GameState} */ (this.#state);
    const controller = this.#controller;
    const dialog = this.gameOverDialog;
    const localId = controller.getLocalPlayerId?.() ?? null;
    const winner = state.players.find((p) => p.id === state.winnerId);
    $('[data-gameover-title]', dialog).textContent = winner
      ? winner.id === localId ? t('gameover.youWin') : t('gameover.playerWins', { name: winner.name })
      : t('gameover.raceOver');
    $('[data-gameover-subtitle]', dialog).textContent = winner
      ? t('gameover.finished', { turns: tn('gameover.turns', winner.moves), crashes: tn('gameover.crashes', winner.crashes) })
      : state.endReason === 'round-limit'
        ? t('gameover.roundLimit', { rounds: state.maxRounds })
        : t('gameover.allLeft');
    const standings = computeStandings(state, controller.getTrack());
    $('[data-results]', dialog).replaceChildren(
      ...standings.map((s) => {
        const p = /** @type {any} */ (state.players.find((x) => x.id === s.playerId));
        const row = el('tr', {}, [
          el('td', { text: p.status === 'retired' ? '–' : ordinal(s.rank) }),
          el('td', {}, [el('div', { class: 'driver' }, [swatch(p.color), el('span', { class: 'driver-name', text: p.name })])]),
          el('td', { text: String(p.moves) }),
          el('td', { text: String(p.crashes) }),
          el('td', {
            text:
              p.status === 'finished'
                ? t('gameover.cellFinished')
                : p.status === 'retired'
                  ? t('gameover.cellLeft')
                  : Number.isFinite(s.remaining)
                    ? t('gameover.cellUnits', { n: Math.round(s.remaining) })
                    : '–',
          }),
        ]);
        row.classList.toggle('is-winner', p.id === state.winnerId);
        return row;
      }),
    );
    this.#gameOverActionsKey = '';
    this.#renderGameOverActions();
    openDialog(dialog);
  }

  /** (Re)builds the result dialog's hint and buttons, only when they actually change. */
  #renderGameOverActions() {
    const controller = this.#controller;
    const dialog = this.gameOverDialog;
    const hint = this.hooks.gameOverHint?.(controller) ?? '';
    const actions = this.hooks.gameOverActions(controller);
    const key = `${hint}|${actions.map((a) => `${a.label}:${a.primary ? 1 : 0}`).join(',')}`;
    if (key === this.#gameOverActionsKey) return;
    this.#gameOverActionsKey = key;
    $('[data-gameover-hint]', dialog).textContent = hint;
    $('[data-gameover-actions]', dialog).replaceChildren(
      ...actions.map((action) => {
        const button = el('button', { class: action.primary ? 'primary' : 'secondary', text: action.label, attrs: { type: 'button' } });
        button.addEventListener('click', () => {
          closeDialog(dialog);
          action.onClick();
        });
        return button;
      }),
    );
  }
}
