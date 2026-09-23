/**
 * Safe wrappers around localStorage/sessionStorage. Storage can be unavailable
 * (private mode, disabled cookies, quota errors); the game must still work, so
 * every access is guarded and falls back to memory.
 */

/**
 * @typedef {Object} Store
 * @property {<T>(key: string, fallback: T) => T} get
 * @property {(key: string, value: unknown) => void} set
 * @property {(key: string) => void} remove
 */

/** @param {'localStorage' | 'sessionStorage'} name @returns {Storage | null} */
function probe(name) {
  try {
    const storage = /** @type {any} */ (globalThis)[name];
    if (!storage) return null;
    const key = '__racetrack_probe__';
    storage.setItem(key, key);
    storage.removeItem(key);
    return storage;
  } catch {
    return null;
  }
}

/**
 * @param {Storage | null} storage
 * @param {string} prefix
 * @returns {Store}
 */
export function createStore(storage, prefix = 'racetrack.') {
  /** @type {Map<string, string>} */
  const memory = new Map();
  return {
    get(key, fallback) {
      let raw = null;
      try {
        raw = storage ? storage.getItem(prefix + key) : memory.get(key) ?? null;
      } catch {
        raw = memory.get(key) ?? null;
      }
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      memory.set(key, raw);
      try {
        storage?.setItem(prefix + key, raw);
      } catch {
        /* quota exceeded or storage disabled: memory copy is enough */
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        storage?.removeItem(prefix + key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Survives browser restarts: preferences such as the player's name. */
export const preferences = createStore(probe('localStorage'));
/** Per tab: the online session, so a reload rejoins the same seat. */
export const tabSession = createStore(probe('sessionStorage'));
