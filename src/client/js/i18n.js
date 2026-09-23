/**
 * Internationalisation: message catalogs, lookup and page translation.
 *
 * - `t(key, params)` looks a message up in the current language (falling back to
 *   English, then to the key itself) and fills in `{placeholders}`.
 * - `tn(key, count, params)` picks the plural form (`key.one`, `key.other`, …) for
 *   `count` using the language's CLDR plural rules (Intl.PluralRules).
 * - Static page text is marked up in index.html with `data-i18n` (text),
 *   `data-i18n-html` (trusted catalog markup: <strong>, <em>, <kbd> only) and
 *   `data-i18n-attr="attr:key; attr2:key2"`; `applyTranslations()` fills it in.
 *
 * Catalogs are plain objects in ./locales. To add a language, copy en.js, translate
 * the values, and register it in LANGUAGES / CATALOGS below — the test suite checks
 * that every catalog has exactly the same keys and placeholders as English.
 *
 * The lookup functions are DOM-free, so they also work in Node (tests). The page
 * language is chosen in main.js: a saved choice, else the browser's languages.
 */

import en from './locales/en.js';
import es from './locales/es.js';
import it from './locales/it.js';
import pt from './locales/pt.js';

/** @typedef {'en' | 'es' | 'pt' | 'it'} Language */

/** Supported languages, with their names in their own language (for the picker). */
export const LANGUAGES = Object.freeze([
  Object.freeze({ code: 'en', name: 'English' }),
  Object.freeze({ code: 'es', name: 'Español' }),
  Object.freeze({ code: 'pt', name: 'Português' }),
  Object.freeze({ code: 'it', name: 'Italiano' }),
]);

/** @type {Record<Language, Record<string, string>>} */
export const CATALOGS = Object.freeze({ en, es, pt, it });

export const DEFAULT_LANGUAGE = /** @type {Language} */ ('en');

/** @type {Language} */
let current = DEFAULT_LANGUAGE;
/** @type {Set<(language: Language) => void>} */
const listeners = new Set();
/** @type {Map<string, Intl.PluralRules>} */
const pluralRules = new Map();

/** @param {unknown} code @returns {code is Language} */
export function isSupported(code) {
  return typeof code === 'string' && Object.hasOwn(CATALOGS, code);
}

export function getLanguage() {
  return current;
}

/**
 * Best supported language for a list of BCP 47 tags such as navigator.languages
 * ("pt-BR" → "pt"); English if none match.
 * @param {ReadonlyArray<string> | undefined | null} tags
 * @returns {Language}
 */
export function matchLanguage(tags) {
  for (const tag of tags ?? []) {
    const base = String(tag).trim().toLowerCase().split(/[-_]/)[0];
    if (isSupported(base)) return base;
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Switches language and notifies listeners (no-op for unknown or unchanged codes).
 * @param {unknown} code
 * @returns {boolean} whether the language changed
 */
export function setLanguage(code) {
  if (!isSupported(code) || code === current) return false;
  current = code;
  for (const fn of [...listeners]) {
    try {
      fn(code);
    } catch (err) {
      console.error('Language listener failed', err);
    }
  }
  return true;
}

/** @param {(language: Language) => void} fn @returns {() => void} unsubscribe */
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @param {string} key */
export function hasMessage(key) {
  return Object.hasOwn(CATALOGS.en, key);
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
export function t(key, params) {
  const template = lookup(current, key) ?? lookup(DEFAULT_LANGUAGE, key) ?? key;
  return params ? interpolate(template, params) : template;
}

/**
 * Plural-aware lookup: `${key}.one`, `${key}.other`, … chosen for `count`, plus
 * an optional `${key}.zero` for wording like "no crashes". `{count}` is available
 * as a placeholder.
 * @param {string} key @param {number} count @param {Record<string, string | number>} [params]
 */
export function tn(key, count, params = {}) {
  const category = rulesFor(current).select(count);
  const template =
    (count === 0 ? lookup(current, `${key}.zero`) : undefined) ??
    lookup(current, `${key}.${category}`) ??
    lookup(current, `${key}.other`) ??
    lookup(DEFAULT_LANGUAGE, `${key}.${rulesFor(DEFAULT_LANGUAGE).select(count)}`) ??
    lookup(DEFAULT_LANGUAGE, `${key}.other`) ??
    key;
  return interpolate(template, { count, ...params });
}

/**
 * A user-facing message for an error code (protocol or engine), falling back to
 * the (English) message that came with the error.
 * @param {string | undefined | null} code @param {string} [fallback]
 */
export function errorMessage(code, fallback) {
  const key = `error.${code}`;
  if (code && hasMessage(key)) return t(key);
  return fallback ?? t('error.UNKNOWN');
}

/**
 * "1st", "1.º", "1º" … in the current language; a plain number for languages
 * without a rule here (always understood, never wrong).
 * @param {number} n
 */
export function formatOrdinal(n) {
  switch (current) {
    case 'en': {
      const mod100 = n % 100;
      if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
      return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
    }
    case 'es':
      return `${n}.º`;
    case 'pt':
    case 'it':
      return `${n}º`;
    default:
      return String(n);
  }
}

/**
 * Translates the static page text inside `root` (browser only).
 * @param {ParentNode} [root]
 */
export function applyTranslations(root = document) {
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-i18n]'))) {
    node.textContent = t(/** @type {string} */ (node.dataset.i18n));
  }
  // Only ever fed from our own catalogs (never user input), and the test suite
  // checks that those strings use nothing but <strong>, <em>, <kbd> and <span>.
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-i18n-html]'))) {
    node.innerHTML = t(/** @type {string} */ (node.dataset.i18nHtml));
  }
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-i18n-attr]'))) {
    for (const pair of /** @type {string} */ (node.dataset.i18nAttr).split(';')) {
      const [attr, key] = pair.split(':').map((part) => part.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    }
  }
  if (root === document) {
    document.documentElement.lang = current;
    document.title = t('app.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('app.description'));
  }
}

/** @param {Language} language @param {string} key @returns {string | undefined} */
function lookup(language, key) {
  const catalog = CATALOGS[language];
  return Object.hasOwn(catalog, key) ? catalog[key] : undefined;
}

/** @param {string} template @param {Record<string, string | number>} params */
function interpolate(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}

/** @param {Language} language */
function rulesFor(language) {
  let rules = pluralRules.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(language);
    pluralRules.set(language, rules);
  }
  return rules;
}
