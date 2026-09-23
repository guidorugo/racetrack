/** Online screens: the create/join menu and the room lobby. */

import { MAX_PLAYERS } from '../../shared/constants.js';
import { MIN_ONLINE_PLAYERS, normalizeRoomCode, ROOM_CODE_LENGTH } from '../../shared/protocol.js';
import { sanitizeName } from '../../shared/validation.js';
import { $, $all, el, setFormError, swatch, toast } from './dom.js';
import { levelLabel } from './format.js';
import { t, tn } from './i18n.js';
import { preferences } from './storage.js';

/** @typedef {import('./online.js').OnlineSession} OnlineSession */

const STATUSES = new Set(['idle', 'connecting', 'open', 'reconnecting', 'failed', 'replaced', 'closed']);

/** Updates every connection indicator on the page. @param {string} status */
export function renderConnection(status) {
  const cls = status === 'open' ? 'is-ok' : status === 'connecting' || status === 'reconnecting' ? 'is-warn' : status === 'idle' ? '' : 'is-bad';
  for (const dot of $all('[data-conn-dot]')) dot.className = `dot ${cls}`.trim();
  for (const text of $all('[data-conn-text]')) text.textContent = STATUSES.has(status) ? t(`conn.${status}`) : status;
}

export class OnlineMenu {
  /**
   * @param {HTMLElement} screen
   * @param {() => OnlineSession} getSession
   */
  constructor(screen, getSession) {
    this.screen = screen;
    this.getSession = getSession;
    this.nameInput = /** @type {HTMLInputElement} */ ($('#online-name', screen));
    this.createForm = /** @type {HTMLFormElement} */ ($('#form-create', screen));
    this.joinForm = /** @type {HTMLFormElement} */ ($('#form-join', screen));
    this.codeInput = /** @type {HTMLInputElement} */ ($('input[name="code"]', this.joinForm));
    this.busy = false;

    this.createForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = this.#readName();
      if (!name) return;
      const data = new FormData(this.createForm);
      const settings = {
        trackId: String(data.get('track')),
        laps: Number(data.get('laps')),
        turnTimeLimit: Number(data.get('turnTimeLimit')),
      };
      this.#run((session) => session.createRoom(name, settings));
    });

    this.joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = this.#readName();
      if (!name) return;
      const code = normalizeRoomCode(this.codeInput.value);
      if (!code) {
        this.#error(t('online.errorCode', { length: ROOM_CODE_LENGTH }));
        this.codeInput.focus();
        return;
      }
      this.#run((session) => session.joinRoom(code, name));
    });
  }

  /** @param {{ code?: string | null }} [options] */
  prepare({ code } = {}) {
    this.nameInput.value = preferences.get('name', '') || this.nameInput.value;
    if (code) this.codeInput.value = code;
    this.#error(null);
    this.getSession().connect();
  }

  #readName() {
    const name = sanitizeName(this.nameInput.value);
    if (!name) {
      this.#error(t('online.errorName'));
      this.nameInput.focus();
      return null;
    }
    preferences.set('name', name);
    this.#error(null);
    return name;
  }

  /** @param {(session: OnlineSession) => Promise<unknown>} action */
  async #run(action) {
    if (this.busy) return;
    this.busy = true;
    const buttons = /** @type {HTMLButtonElement[]} */ ($all('button[type="submit"]', this.screen));
    buttons.forEach((b) => (b.disabled = true));
    try {
      await action(this.getSession());
      // Success: the lobby appears when the room snapshot arrives.
    } catch (err) {
      this.#error(/** @type {Error} */ (err).message);
    } finally {
      this.busy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  /** @param {string | null} message */
  #error(message) {
    setFormError(this.screen, message);
  }
}

export class LobbyScreen {
  /**
   * @param {HTMLElement} screen
   * @param {() => OnlineSession} getSession
   * @param {{ onViewRace: () => void, onLeave: () => void }} hooks
   */
  constructor(screen, getSession, hooks) {
    this.screen = screen;
    this.getSession = getSession;
    this.hooks = hooks;
    this.ui = {
      code: $('[data-room-code]', screen),
      invite: /** @type {HTMLInputElement} */ ($('[data-invite-link]', screen)),
      seats: $('[data-seat-list]', screen),
      seatCount: $('[data-seat-count]', screen),
      result: $('[data-lobby-result]', screen),
      hint: $('[data-lobby-hint]', screen),
      botLevel: /** @type {HTMLSelectElement} */ ($('[data-bot-level]', screen)),
      settings: $('[data-settings]', screen),
      start: /** @type {HTMLButtonElement} */ ($('[data-action="start-online"]', screen)),
      addBot: /** @type {HTMLButtonElement} */ ($('[data-action="add-bot"]', screen)),
      viewRace: /** @type {HTMLButtonElement} */ ($('[data-action="view-race"]', screen)),
    };

    this.ui.addBot.addEventListener('click', () => this.getSession().addBot(this.ui.botLevel.value));
    this.ui.start.addEventListener('click', () => this.getSession().startGame());
    this.ui.viewRace.addEventListener('click', () => this.hooks.onViewRace());
    $('[data-action="leave-room"]', screen).addEventListener('click', () => this.hooks.onLeave());
    $('[data-action="copy-invite"]', screen).addEventListener('click', () => this.#copyInvite());
    for (const select of /** @type {HTMLSelectElement[]} */ ($all('select', this.ui.settings))) {
      select.addEventListener('change', () => {
        const value = select.name === 'trackId' ? select.value : Number(select.value);
        this.getSession().updateSettings({ [select.name]: value });
      });
    }
  }

  /** @param {any} room */
  render(room) {
    const session = this.getSession();
    const isHost = room.hostId === session.playerId;
    this.screen.classList.toggle('screen-lobby-guest', !isHost);
    this.ui.code.textContent = room.code;
    this.ui.invite.value = `${location.origin}/?room=${room.code}`;
    this.ui.seatCount.textContent = `(${room.seats.length}/${MAX_PLAYERS})`;

    const items = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const seat = room.seats[i];
      if (!seat) {
        items.push(el('li', { class: 'seat is-open', text: t('lobby.openSeat') }));
        continue;
      }
      const badges = [];
      if (seat.playerId === room.hostId) badges.push(el('span', { class: 'badge host', text: t('badge.host') }));
      if (seat.playerId === session.playerId) badges.push(el('span', { class: 'badge you', text: t('badge.you') }));
      if (seat.kind === 'bot') badges.push(el('span', { class: 'badge', text: t('badge.bot', { level: levelLabel(seat.botLevel) }) }));
      if (seat.kind === 'human' && !seat.connected) badges.push(el('span', { class: 'badge warn', text: t('badge.reconnecting') }));
      let remove = null;
      if (isHost && seat.playerId !== session.playerId && room.phase !== 'playing') {
        remove = el('button', { class: 'secondary small', text: t('lobby.remove'), attrs: { type: 'button', 'aria-label': t('lobby.removeName', { name: seat.name }) } });
        remove.addEventListener('click', () => session.removePlayer(seat.playerId));
      }
      items.push(el('li', { class: 'seat' }, [swatch(seat.color), el('span', { class: 'seat-name', text: seat.name }), ...badges, remove]));
    }
    this.ui.seats.replaceChildren(...items);

    for (const select of /** @type {HTMLSelectElement[]} */ ($all('select', this.ui.settings))) {
      const value = room.settings[select.name];
      if (value !== undefined) select.value = String(value);
      select.disabled = !isHost;
    }

    const enough = room.seats.length >= MIN_ONLINE_PLAYERS;
    this.ui.start.disabled = !enough;
    this.ui.start.textContent = room.phase === 'finished' ? t('lobby.raceAgain') : t('common.startRace');
    this.ui.addBot.disabled = room.seats.length >= MAX_PLAYERS;
    this.ui.hint.textContent = isHost
      ? enough
        ? t('lobby.hintReady')
        : t('lobby.hintNeedPlayers', { n: MIN_ONLINE_PLAYERS })
      : t('lobby.hintWaiting');

    const game = room.phase === 'finished' ? room.game : null;
    const winner = game?.players.find((/** @type {any} */ p) => p.id === game.winnerId);
    this.ui.result.hidden = !game;
    this.ui.result.textContent = game
      ? winner
        ? tn('lobby.lastRaceWon', winner.moves, { name: winner.name })
        : t('lobby.lastRaceNone')
      : '';
    this.ui.viewRace.hidden = !game;
  }

  async #copyInvite() {
    const link = this.ui.invite.value;
    try {
      await navigator.clipboard.writeText(link);
      toast(t('lobby.copied'), { type: 'success' });
    } catch {
      this.ui.invite.select();
      toast(t('lobby.copyManually'));
    }
  }
}
