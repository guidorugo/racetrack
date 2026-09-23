/** Game-wide constants shared by the engine, server and client. */

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 4;

export const DEFAULT_LAPS = 1;
export const MAX_LAPS = 3;

/** Safety net so a game can never run forever (e.g. every player idling in place). */
export const DEFAULT_MAX_ROUNDS = 200;
export const MAX_ROUNDS_LIMIT = 1000;

export const MAX_NAME_LENGTH = 20;

/** Colour-blind friendly (Okabe–Ito) car colours, in seat order. */
export const PLAYER_COLORS = Object.freeze(['#0072B2', '#D55E00', '#009E73', '#CC79A7']);

/** Names handed out to bot drivers, in order. */
export const BOT_NAMES = Object.freeze(['Turbo', 'Nitro', 'Piston', 'Sprocket', 'Axle', 'Gearbox']);

/** @typedef {'easy' | 'medium' | 'hard'} BotLevel */
/** @type {ReadonlyArray<BotLevel>} */
export const BOT_LEVELS = Object.freeze(['easy', 'medium', 'hard']);

/**
 * The nine possible accelerations, in reading order (top-left to bottom-right),
 * which matches the numeric keypad layout 7 8 9 / 4 5 6 / 1 2 3.
 * Remember that y grows downwards, so `y: -1` means "up" on screen.
 * @type {ReadonlyArray<Readonly<import('./vec.js').Vec>>}
 */
export const ACCELERATIONS = Object.freeze(
  [
    { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
    { x: -1, y: 0 },  { x: 0, y: 0 },  { x: 1, y: 0 },
    { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
  ].map((a) => Object.freeze(a)),
);

/** Numeric keypad key for each entry of {@link ACCELERATIONS}. */
export const NUMPAD_KEYS = Object.freeze(['7', '8', '9', '4', '5', '6', '1', '2', '3']);

/** Letter keys (QWE / ASD / ZXC block) for each entry of {@link ACCELERATIONS}. */
export const LETTER_KEYS = Object.freeze(['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c']);
