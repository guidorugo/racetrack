/** Text helpers for the UI, in the current language (see i18n.js). */

import { formatOrdinal, t } from './i18n.js';

/** Arrow glyph for each acceleration, in ACCELERATIONS (numpad) order. */
export const ARROWS = Object.freeze(['↖', '↑', '↗', '←', '•', '→', '↙', '↓', '↘']);
const DIRECTION_KEYS = Object.freeze(['upLeft', 'up', 'upRight', 'left', 'keep', 'right', 'downLeft', 'down', 'downRight']);

/** Name of the acceleration at `index` (numpad order), e.g. "up-left". @param {number} index */
export function directionName(index) {
  return t(`direction.${DIRECTION_KEYS[index]}`);
}

/** @param {{x: number, y: number}} v */
export const fmtPoint = (v) => `(${v.x}, ${v.y})`;
/** @param {{x: number, y: number}} v */
export const fmtVector = (v) => `⟨${v.x}, ${v.y}⟩`;
/** @param {{x: number, y: number}} v */
export const speedOf = (v) => Math.max(Math.abs(v.x), Math.abs(v.y));

/** @param {number} n */
export function ordinal(n) {
  return formatOrdinal(n);
}

/** @param {string | null | undefined} level */
export function levelLabel(level) {
  return level ? t(`level.${level}`) : '';
}

/**
 * One line for the race log.
 * @param {import('../../shared/game.js').MoveRecord} move
 * @param {string} name
 * @param {{ laps: number, lapProgress?: number, place?: number | null }} race
 *   lapProgress: the lap count after this move; place: the driver's finishing position, once known
 */
export function describeMove(move, name, race) {
  const pos = fmtPoint(move.to);
  let text;
  if (move.outcome === 'won') text = t('log.won', { name });
  else if (move.outcome === 'finished') text = t('log.finished', { name, place: race.place ? ordinal(race.place) : '?' });
  else if (move.outcome === 'crashed') text = t(move.crash === 'car' ? 'log.crashCar' : 'log.crashWall', { name });
  else if (move.lapDelta > 0) text = t('log.lap', { name, lap: race.lapProgress ?? '?', laps: race.laps });
  else if (move.lapDelta < 0) text = t('log.backwards', { name });
  else if (move.velocity.x === 0 && move.velocity.y === 0) text = t('log.stays', { name, pos });
  else text = t('log.moves', { name, pos, speed: speedOf(move.velocity) });
  if (move.note === 'timeout') text += ` ${t('log.noteTimeout')}`;
  else if (move.note === 'autopilot') text += ` ${t('log.noteAutopilot')}`;
  return text;
}

/**
 * Describes a move option for the preview line / screen readers.
 * @param {import('../../shared/game.js').MoveOption} option
 */
export function describeOption(option) {
  const params = { pos: fmtPoint(option.target), speed: speedOf(option.velocity) };
  if (option.outcome === 'win') return t('option.finish', params);
  if (option.outcome === 'crash') return option.crash === 'car' ? t('option.crashCar', params) : t('option.crashWall');
  return t('option.move', params);
}

/** Seconds left until `deadline` (epoch ms), never negative. @param {number} deadline @param {number} now */
export function secondsLeft(deadline, now) {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
