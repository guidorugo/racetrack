/** Setup forms for single-player and local multiplayer races. */

import { BOT_LEVELS, BOT_NAMES, DEFAULT_FINISH_MODE, FINISH_MODES, MAX_PLAYERS, PLAYER_COLORS } from '../../shared/constants.js';
import { DEFAULT_TRACK_ID, hasTrack } from '../../shared/tracks/index.js';
import { sanitizeName } from '../../shared/validation.js';
import { $, $all, setFormError } from './dom.js';
import { applyTranslations, hasMessage, t } from './i18n.js';
import { preferences } from './storage.js';

/**
 * @typedef {import('../../shared/game.js').PlayerConfig} PlayerConfig
 * @typedef {import('../../shared/constants.js').FinishMode} FinishMode
 * @typedef {{ trackId: string, laps: number, finishMode: FinishMode, players: PlayerConfig[] }} RaceSetup
 * @typedef {{ relocalize: () => void }} SetupForm
 */

/** @param {FormData} data */
function readCommon(data) {
  const trackId = String(data.get('track') ?? DEFAULT_TRACK_ID);
  const laps = Number(data.get('laps') ?? 1);
  const finishMode = /** @type {FinishMode} */ (data.get('finishMode'));
  return {
    trackId: hasTrack(trackId) ? trackId : DEFAULT_TRACK_ID,
    laps: [1, 2, 3].includes(laps) ? laps : 1,
    finishMode: FINISH_MODES.includes(finishMode) ? finishMode : DEFAULT_FINISH_MODE,
  };
}

/**
 * Names we filled in ourselves are marked "automatic" until the player edits
 * them, so they can follow a language change without clobbering real names.
 * @param {HTMLInputElement} input @param {string} value
 */
function setAutoName(input, value) {
  input.value = value;
  input.dataset.auto = 'true';
}

/** @param {HTMLInputElement} input */
function trackEdits(input) {
  input.addEventListener('input', () => delete input.dataset.auto);
}

/**
 * @param {HTMLFormElement} form
 * @param {(setup: RaceSetup) => void} onStart
 * @returns {SetupForm}
 */
export function initSinglePlayerForm(form, onStart) {
  const nameInput = /** @type {HTMLInputElement} */ ($('input[name="name"]', form));
  const savedName = preferences.get('name', '');
  if (savedName) nameInput.value = savedName;
  else setAutoName(nameInput, t('player.defaultName'));
  trackEdits(nameInput);
  const saved = preferences.get('singleSetup', null);
  if (saved) {
    const bots = form.querySelector(`input[name="bots"][value="${Number(saved.bots)}"]`);
    if (bots) /** @type {HTMLInputElement} */ (bots).checked = true;
    const level = BOT_LEVELS.includes(saved.level) ? form.querySelector(`input[name="level"][value="${saved.level}"]`) : null;
    if (level) /** @type {HTMLInputElement} */ (level).checked = true;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = sanitizeName(data.get('name'));
    if (!name) {
      setFormError(form, t('single.errorName'));
      nameInput.focus();
      return;
    }
    const botCount = Math.min(MAX_PLAYERS - 1, Math.max(1, Number(data.get('bots')) || 1));
    const level = /** @type {import('../../shared/constants.js').BotLevel} */ (
      BOT_LEVELS.includes(/** @type {any} */ (data.get('level'))) ? data.get('level') : 'medium'
    );
    setFormError(form, null);
    if (!nameInput.dataset.auto) preferences.set('name', name);
    preferences.set('singleSetup', { bots: botCount, level });
    const players = [{ id: 'p1', name, kind: /** @type {const} */ ('human') }];
    for (let i = 0; i < botCount; i++) {
      players.push({ id: `bot${i + 1}`, name: BOT_NAMES[i], kind: 'bot', botLevel: level });
    }
    onStart({ ...readCommon(data), players });
  });

  return {
    relocalize() {
      if (nameInput.dataset.auto) nameInput.value = t('player.defaultName');
      setFormError(form, null);
    },
  };
}

/**
 * @param {HTMLFormElement} form
 * @param {HTMLTemplateElement} template
 * @param {(setup: RaceSetup) => void} onStart
 * @returns {SetupForm}
 */
export function initLocalForm(form, template, onStart) {
  const container = $('#local-slots', form);
  const defaults = [
    { kind: 'human', name: preferences.get('name', ''), level: 'medium' },
    { kind: 'human', name: '', level: 'medium' },
    { kind: 'none', name: '', level: 'medium' },
    { kind: 'none', name: '', level: 'medium' },
  ];
  const saved = preferences.get('localSetup', null);
  const slotsConfig = Array.isArray(saved) && saved.length === MAX_PLAYERS ? saved : defaults;

  /** Default name for a seat, in the current language. @param {string} kind @param {number} i */
  const defaultName = (kind, i) => (kind === 'bot' ? BOT_NAMES[i] : t('player.numbered', { n: i + 1 }));

  const slots = slotsConfig.map((config, i) => {
    const node = /** @type {HTMLElement} */ (/** @type {DocumentFragment} */ (template.content.cloneNode(true)).firstElementChild);
    applyTranslations(node);
    const kind = /** @type {HTMLSelectElement} */ ($('select[name="kind"]', node));
    const name = /** @type {HTMLInputElement} */ ($('input[name="name"]', node));
    const level = /** @type {HTMLSelectElement} */ ($('select[name="level"]', node));
    kind.value = ['human', 'bot', 'none'].includes(config.kind) ? config.kind : 'none';
    level.value = BOT_LEVELS.includes(config.level) ? config.level : 'medium';
    if (typeof config.name === 'string' && config.name && !config.auto) name.value = config.name;
    else setAutoName(name, defaultName(kind.value, i));
    trackEdits(name);
    container.append(node);
    return { node, kind, name, level };
  });

  const labelSlots = () => {
    slots.forEach((slot, i) => {
      slot.name.setAttribute('aria-label', t('local.seatNameN', { n: i + 1 }));
      slot.kind.setAttribute('aria-label', t('local.seatTypeN', { n: i + 1 }));
      slot.level.setAttribute('aria-label', t('local.seatLevelN', { n: i + 1 }));
    });
  };

  const refresh = () => {
    let colorIndex = 0;
    slots.forEach((slot, i) => {
      const active = slot.kind.value !== 'none';
      slot.node.classList.toggle('is-empty', !active);
      slot.name.disabled = !active;
      slot.level.disabled = slot.kind.value !== 'bot';
      slot.level.hidden = slot.kind.value !== 'bot';
      const swatchNode = /** @type {HTMLElement} */ ($('.slot-swatch', slot.node));
      swatchNode.style.backgroundColor = active ? PLAYER_COLORS[colorIndex++] : 'transparent';
      if (slot.name.dataset.auto || !slot.name.value) setAutoName(slot.name, defaultName(slot.kind.value, i));
    });
  };
  slots.forEach((slot) => slot.kind.addEventListener('change', refresh));
  labelSlots();
  refresh();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const active = slots.filter((s) => s.kind.value !== 'none');
    if (active.length < 2) {
      setFormError(form, t('local.errorTooFew'));
      return;
    }
    const names = active.map((s) => sanitizeName(s.name.value));
    const missing = names.findIndex((n) => !n);
    if (missing !== -1) {
      setFormError(form, t('local.errorNoName'));
      active[missing].name.focus();
      return;
    }
    const lower = names.map((n) => /** @type {string} */ (n).toLowerCase());
    if (new Set(lower).size !== lower.length) {
      setFormError(form, t('local.errorSameName'));
      return;
    }
    setFormError(form, null);
    preferences.set(
      'localSetup',
      slots.map((s) => ({ kind: s.kind.value, name: s.name.value, level: s.level.value, auto: !!s.name.dataset.auto })),
    );
    const players = active.map((slot, i) => ({
      id: `p${i + 1}`,
      name: /** @type {string} */ (names[i]),
      kind: /** @type {'human' | 'bot'} */ (slot.kind.value),
      botLevel: slot.kind.value === 'bot' ? /** @type {any} */ (slot.level.value) : undefined,
    }));
    onStart({ ...readCommon(data), players });
  });

  return {
    relocalize() {
      labelSlots();
      refresh();
      setFormError(form, null);
    },
  };
}

/**
 * Fills every track <select> from the registry, keeping each current selection.
 * @param {{ id: string, name: string }[]} tracks
 */
export function populateTrackSelects(tracks) {
  for (const select of /** @type {HTMLSelectElement[]} */ ($all('select[data-track-select]'))) {
    const selected = select.value;
    select.replaceChildren(
      ...tracks.map((track) => {
        const option = document.createElement('option');
        const key = `track.${track.id}.name`;
        option.value = track.id;
        option.textContent = hasMessage(key) ? t(key) : track.name;
        return option;
      }),
    );
    if (selected && tracks.some((track) => track.id === selected)) select.value = selected;
  }
}
