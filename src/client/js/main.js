/**
 * Racetrack browser client — entry point.
 *
 * Wires the screens together and owns the lifecycle of the active game
 * controller: a LocalController for single-player / hot-seat races, or an
 * OnlineGameController backed by an OnlineSession for online races.
 */

import { MIN_ONLINE_PLAYERS, normalizeRoomCode } from '../../shared/protocol.js';
import { getTrack, listTracks } from '../../shared/tracks/index.js';
import { Connection } from './connection.js';
import { $, $all, confirmDialog, openDialog, showScreen, toast } from './dom.js';
import { GameView } from './gameView.js';
import {
  applyTranslations,
  errorMessage,
  getLanguage,
  isSupported,
  LANGUAGES,
  matchLanguage,
  onLanguageChange,
  setLanguage,
  t,
} from './i18n.js';
import { LobbyScreen, OnlineMenu, renderConnection } from './lobby.js';
import { LocalController } from './localController.js';
import { OnlineGameController, OnlineSession, socketUrlFor } from './online.js';
import { initLocalForm, initSinglePlayerForm, populateTrackSelects } from './setup.js';
import { preferences, tabSession } from './storage.js';

/**
 * @typedef {import('./setup.js').RaceSetup} RaceSetup
 */

const app = {
  /** @type {import('./setup.js').SetupForm[]} */ setupForms: [],
  /** @type {GameView | null} */ gameView: null,
  /** @type {LocalController | OnlineGameController | null} */ controller: null,
  /** @type {OnlineSession | null} */ session: null,
  /** @type {OnlineMenu | null} */ onlineMenu: null,
  /** @type {LobbyScreen | null} */ lobby: null,
};

function main() {
  initLanguage();
  populateTrackSelects(listTracks());
  app.gameView = new GameView($('#screen-game'), { gameOverActions, gameOverHint });
  app.setupForms = [
    initSinglePlayerForm($('#form-single'), (setup) => startLocalRace('single', setup)),
    initLocalForm($('#form-local'), $('#tpl-local-slot'), (setup) => startLocalRace('local', setup)),
  ];
  app.onlineMenu = new OnlineMenu($('#screen-online'), getSession);
  app.lobby = new LobbyScreen($('#screen-lobby'), getSession, { onViewRace: viewLastRace, onLeave: () => leaveRoom(true) });

  document.addEventListener('click', onActionClick);
  $('#brand-link').addEventListener('click', (event) => {
    event.preventDefault();
    goHome();
  });

  // Invite links look like /?room=CODE. Drop the parameter once read, so a
  // reload doesn't try to join again (the tab session handles reloads).
  const params = new URLSearchParams(location.search);
  const inviteCode = normalizeRoomCode(params.get('room') ?? '');
  if (params.has('room') || params.has('lang')) history.replaceState(null, '', location.pathname);

  const seat = tabSession.get('online-session', null);
  if (tabSession.get('pending-leave', null)) getSession().connect(); // finish leaving a room we left offline
  if (seat && inviteCode && seat.code !== inviteCode) chooseBetweenRooms(seat.code, inviteCode);
  else if (seat) resumeOnline();
  else if (inviteCode) openOnline(inviteCode);
  else showScreen('screen-menu');
}

/**
 * Picks the page language — an explicit ?lang= parameter, else the saved choice,
 * else the browser's preferred languages — and wires up the language picker.
 */
function initLanguage() {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  const saved = preferences.get('lang', null);
  const browser = matchLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
  const language = isSupported(fromUrl) ? fromUrl : isSupported(saved) ? saved : browser;
  if (isSupported(fromUrl)) preferences.set('lang', fromUrl);
  setLanguage(language);

  const picker = /** @type {HTMLSelectElement} */ ($('#language-select'));
  picker.replaceChildren(
    ...LANGUAGES.map(({ code, name }) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = name;
      option.lang = code;
      return option;
    }),
  );
  picker.value = getLanguage();
  picker.addEventListener('change', () => {
    preferences.set('lang', picker.value);
    setLanguage(picker.value);
    picker.blur(); // give the keyboard back to the game
  });

  applyTranslations();
  onLanguageChange(() => {
    picker.value = getLanguage();
    applyTranslations();
    populateTrackSelects(listTracks());
    for (const form of app.setupForms) form.relocalize();
    renderConnection(app.session?.status ?? 'idle');
    if (app.session?.room) app.lobby?.render(app.session.room);
    app.gameView?.refreshLanguage();
  });
}

/**
 * This tab still holds a seat in one room but was opened with an invite to another.
 * @param {string} current @param {string} invited
 */
async function chooseBetweenRooms(current, invited) {
  showScreen('screen-menu');
  const join = await confirmDialog({
    title: t('confirm.switchRoom.title', { code: invited }),
    text: t('confirm.switchRoom.text', { code: invited, current }),
    okLabel: t('confirm.switchRoom.ok', { code: invited }),
  });
  if (!join) {
    resumeOnline();
    return;
  }
  getSession().leaveRoom(); // delivered as soon as we're connected
  openOnline(invited);
}

/** @param {MouseEvent} event */
function onActionClick(event) {
  const target = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest?.('[data-action]'));
  if (!target) return;
  switch (target.dataset.action) {
    case 'menu':
      goHome();
      break;
    case 'single':
      showScreen('screen-single');
      break;
    case 'local':
      showScreen('screen-local');
      break;
    case 'online':
      openOnline();
      break;
    case 'rules':
      openDialog(/** @type {HTMLDialogElement} */ ($('#dialog-rules')));
      break;
    case 'restart':
      restartLocalRace();
      break;
    case 'leave-game':
      leaveGame();
      break;
    case 'to-lobby':
      showLobby();
      break;
    default:
      break; // screen-specific actions are handled by their screens
  }
}

function currentScreen() {
  return $all('main > .screen').find((s) => !s.hidden)?.id ?? null;
}

async function goHome() {
  const controller = app.controller;
  if (controller && currentScreen() === 'screen-game') {
    await leaveGame();
    return;
  }
  if (app.session?.room && (currentScreen() === 'screen-lobby' || currentScreen() === 'screen-game')) {
    await leaveRoom();
    if (app.session.room) return; // cancelled
  }
  // Leaving the online area: drop any create/join still waiting for a connection,
  // and stop reconnecting if there is nothing left to do online.
  app.session?.cancelPending();
  app.session?.disconnectIfIdle();
  showScreen('screen-menu');
}

// --- Local races ---------------------------------------------------------------

/** @param {'single' | 'local'} mode @param {RaceSetup} setup */
function startLocalRace(mode, setup) {
  try {
    const controller = new LocalController({ mode, track: getTrack(setup.trackId), players: setup.players, laps: setup.laps, finishMode: setup.finishMode });
    showGame(controller);
  } catch (err) {
    toast(errorMessage(/** @type {any} */ (err).code, /** @type {Error} */ (err).message), { type: 'error' });
  }
}

async function restartLocalRace() {
  const controller = app.controller;
  if (!(controller instanceof LocalController)) return;
  if (controller.getState().status === 'playing') {
    const ok = await confirmDialog({ title: t('confirm.restart.title'), text: t('confirm.restart.text'), okLabel: t('confirm.restart.ok') });
    if (!ok) return;
  }
  controller.restart();
}

/** @param {LocalController | OnlineGameController} controller */
function showGame(controller) {
  stopGame();
  app.controller = controller;
  showScreen('screen-game'); // visible first, so the canvas has a size
  /** @type {GameView} */ (app.gameView).mount(controller);
}

function stopGame() {
  if (!app.controller) return;
  app.gameView?.unmount();
  app.controller.dispose();
  app.controller = null;
}

async function leaveGame() {
  const controller = app.controller;
  if (!controller) {
    showScreen('screen-menu');
    return;
  }
  if (controller.mode === 'online') {
    await leaveRoom();
    return;
  }
  if (controller.getState().status === 'playing') {
    const ok = await confirmDialog({ title: t('confirm.leaveLocal.title'), text: t('confirm.leaveLocal.text'), okLabel: t('confirm.leaveLocal.ok') });
    if (!ok) return;
  }
  stopGame();
  showScreen('screen-menu');
}

/** @param {LocalController | OnlineGameController} controller */
function gameOverActions(controller) {
  if (controller instanceof LocalController) {
    return [
      { label: t('action.raceAgain'), primary: true, onClick: () => controller.restart() },
      {
        label: t('action.changeSetup'),
        onClick: () => {
          stopGame();
          showScreen(controller.mode === 'single' ? 'screen-single' : 'screen-local');
        },
      },
      {
        label: t('action.mainMenu'),
        onClick: () => {
          stopGame();
          showScreen('screen-menu');
        },
      },
    ];
  }
  const session = getSession();
  const canRematch = session.isHost && (session.room?.seats.length ?? 0) >= MIN_ONLINE_PLAYERS;
  const actions = [];
  if (canRematch) actions.push({ label: t('action.raceAgain'), primary: true, onClick: () => session.startGame() });
  actions.push({ label: t('action.backToLobby'), primary: !canRematch, onClick: showLobby });
  actions.push({ label: t('action.leaveRoom'), onClick: () => leaveRoom(true) });
  return actions;
}

/** @param {LocalController | OnlineGameController} controller */
function gameOverHint(controller) {
  if (!(controller instanceof OnlineGameController)) return '';
  const session = getSession();
  if (!session.isHost) return t('hint.hostCanRestart');
  if ((session.room?.seats.length ?? 0) < MIN_ONLINE_PLAYERS) return t('hint.everyoneLeft');
  return '';
}

// --- Online ------------------------------------------------------------------------

function getSession() {
  if (!app.session) {
    const connection = new Connection({ url: socketUrlFor(location) });
    const session = new OnlineSession({ connection, store: tabSession });
    session.subscribe(onSessionEvent);
    window.addEventListener('online', () => session.retryNow());
    app.session = session;
    renderConnection(session.status);
  }
  return app.session;
}

/** @param {string | null} [code] */
function openOnline(code = null) {
  const session = getSession();
  if (session.room) {
    onRoom(session.room);
    return;
  }
  app.onlineMenu?.prepare({ code });
  showScreen('screen-online');
}

function resumeOnline() {
  const session = getSession();
  app.onlineMenu?.prepare();
  showScreen('screen-online');
  toast(t('toast.rejoining'));
  session.resume().catch((err) => {
    toast(t('toast.rejoinFailed', { message: err.message }), { type: 'error' });
  });
}

/** @param {import('./online.js').SessionEvent} event */
function onSessionEvent(event) {
  switch (event.type) {
    case 'status':
      renderConnection(event.status);
      break;
    case 'room':
      onRoom(event.room);
      break;
    case 'left':
      onLeftRoom(event.reason);
      break;
    case 'error':
      // Rejected moves are reported by the race screen itself.
      if (event.requestType === 'move' && app.controller instanceof OnlineGameController) break;
      toast(event.message, { type: 'error' });
      break;
    default:
      break;
  }
}

/** Keeps the right screen showing as the room changes phase. @param {any} room */
function onRoom(room) {
  app.lobby?.render(room);
  const inOnlineGame = app.controller instanceof OnlineGameController;
  if (room.phase === 'playing') {
    if (!inOnlineGame) showGame(new OnlineGameController(getSession()));
  } else if (room.phase === 'lobby') {
    if (inOnlineGame) stopGame();
    if (currentScreen() !== 'screen-lobby') showScreen('screen-lobby');
  } else if (!inOnlineGame && currentScreen() !== 'screen-lobby') {
    showScreen('screen-lobby'); // finished race, e.g. after rejoining
  }
}

/** @param {string} reason */
function onLeftRoom(reason) {
  const wasInRoom = app.controller instanceof OnlineGameController || currentScreen() === 'screen-lobby' || currentScreen() === 'screen-online';
  if (app.controller instanceof OnlineGameController) stopGame();
  /** @type {Record<string, string>} */
  const messages = {
    kicked: 'left.kicked',
    'room-closed': 'left.roomClosed',
    replaced: 'left.replaced',
    'session-lost': 'left.sessionLost',
  };
  if (messages[reason]) toast(t(messages[reason]), { type: reason === 'room-closed' ? 'info' : 'error', timeoutMs: 6_000 });
  if (wasInRoom) {
    app.onlineMenu?.prepare();
    showScreen('screen-online');
  }
}

/** @param {boolean} [skipConfirm] */
async function leaveRoom(skipConfirm = false) {
  const session = getSession();
  if (!skipConfirm && session.room) {
    const racing = session.room.phase === 'playing';
    const ok = await confirmDialog({
      title: racing ? t('confirm.leaveRace.title') : t('confirm.leaveRoom.title', { code: session.room.code }),
      text: racing ? t('confirm.leaveRace.text') : t('confirm.leaveRoom.text'),
      okLabel: t('common.leave'),
    });
    if (!ok) return;
  }
  if (app.controller instanceof OnlineGameController) stopGame();
  session.leaveRoom();
  app.onlineMenu?.prepare();
  showScreen('screen-online');
}

function showLobby() {
  const session = getSession();
  if (session.room?.phase === 'playing') {
    // A new race has already started (maybe while we were away): go to it.
    if (!(app.controller instanceof OnlineGameController)) showGame(new OnlineGameController(session));
    return;
  }
  if (app.controller instanceof OnlineGameController) stopGame();
  if (session.room) {
    app.lobby?.render(session.room);
    showScreen('screen-lobby');
  } else {
    openOnline();
  }
}

function viewLastRace() {
  const session = getSession();
  if (session.room?.game) showGame(new OnlineGameController(session));
}

// --- Boot ------------------------------------------------------------------------------

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

try {
  main();
} catch (err) {
  console.error(err);
  const node = document.getElementById('boot-error');
  if (node) {
    node.textContent = t('app.bootError', { message: /** @type {Error} */ (err).message });
    node.hidden = false;
  }
}
