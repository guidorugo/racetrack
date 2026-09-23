/**
 * Error type shared by the rules engine, the server and the clients.
 * `code` is a stable, machine-readable identifier that also travels over the
 * network protocol, so UIs can react to specific failures.
 */
export class GameError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    /** @type {Record<string, unknown> | undefined} */
    this.details = details;
  }
}

/** Error codes raised by the rules engine. */
export const EngineErrors = Object.freeze({
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_TRACK: 'INVALID_TRACK',
  UNKNOWN_TRACK: 'UNKNOWN_TRACK',
  INVALID_ACCELERATION: 'INVALID_ACCELERATION',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  GAME_OVER: 'GAME_OVER',
  UNKNOWN_PLAYER: 'UNKNOWN_PLAYER',
});
