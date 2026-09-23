/** Input sanitisation helpers shared by client and server. */

import { MAX_NAME_LENGTH } from './constants.js';

// Control characters, invisible formatting characters (incl. bidi overrides),
// line/paragraph separators and unpaired surrogates (e.g. half an emoji left over
// by the length cut below) have no business in a display name.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

/**
 * Normalises a player name: strips invisible characters, collapses whitespace,
 * trims, and truncates to {@link MAX_NAME_LENGTH} characters.
 * @param {unknown} raw
 * @returns {string | null} the cleaned name, or null when nothing usable remains
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .slice(0, MAX_NAME_LENGTH * 8) // bound the work done on hostile input
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const name = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
  return name.length > 0 ? name : null;
}

/** @param {unknown} value */
export function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}
