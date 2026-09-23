import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeMove, describeOption, directionName, levelLabel, ordinal } from '../../src/client/js/format.js';
import {
  CATALOGS,
  errorMessage,
  formatOrdinal,
  getLanguage,
  hasMessage,
  isSupported,
  LANGUAGES,
  matchLanguage,
  onLanguageChange,
  setLanguage,
  t,
  tn,
} from '../../src/client/js/i18n.js';
import { EngineErrors } from '../../src/shared/errors.js';
import { ErrorCode } from '../../src/shared/protocol.js';

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/client');
const en = CATALOGS.en;
const placeholders = (/** @type {string} */ s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** "game.laps.one" → { base: "game.laps", form: "one" } when English has plural forms for that base. */
const pluralForm = (/** @type {string} */ key) => {
  const match = /^(.+)\.(zero|one|two|few|many|other)$/.exec(key);
  return match && Object.hasOwn(en, `${match[1]}.other`) ? { base: match[1], form: match[2] } : null;
};
/** Client-side error codes the UI raises on its own (see online.js / localController.js). */
const CLIENT_ERROR_CODES = ['UNKNOWN', 'OFFLINE', 'BUSY', 'TIMEOUT', 'UNREACHABLE', 'REPLACED', 'DISCONNECTED', 'CANCELLED', 'MOVE_IN_FLIGHT', 'MOVE_FAILED', 'PROTOCOL_MISMATCH'];

afterEach(() => setLanguage('en'));

describe('message catalogs', () => {
  it('registers English, Spanish, Portuguese and Italian', () => {
    assert.deepEqual(LANGUAGES.map((l) => l.code), ['en', 'es', 'pt', 'it']);
    for (const { code } of LANGUAGES) assert.ok(isSupported(code));
  });

  for (const { code } of LANGUAGES) {
    const catalog = CATALOGS[code];

    it(`${code}: has the English keys, with the plural forms its own grammar uses`, () => {
      // Plural messages need .other plus every form the language distinguishes that English
      // has too; they may add forms English lacks (e.g. .few) and drop .zero or the ones the
      // language doesn't use. Everything else must match English key for key.
      const forms = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
      const missing = Object.keys(en).filter((key) => {
        if (Object.hasOwn(catalog, key)) return false;
        const plural = pluralForm(key);
        return !plural || plural.form === 'other' || (plural.form !== 'zero' && forms.includes(plural.form));
      });
      const extra = Object.keys(catalog).filter((key) => {
        if (Object.hasOwn(en, key)) return false;
        const plural = pluralForm(key);
        return !plural || !(plural.form === 'zero' || forms.includes(plural.form));
      });
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
    });

    it(`${code}: uses the same placeholders as English`, () => {
      for (const key of Object.keys(catalog)) {
        const plural = pluralForm(key);
        const reference = Object.hasOwn(en, key) ? en[key] : plural ? en[`${plural.base}.other`] : null;
        if (reference === null) continue; // an unknown key: reported by the test above
        const expected = placeholders(reference);
        // A plural form may spell the number out ("un giro") instead of using {count}.
        const actual = placeholders(catalog[key]);
        if (plural) assert.deepEqual(actual.filter((p) => p !== 'count'), expected.filter((p) => p !== 'count'), `${code} ${key}`);
        else assert.deepEqual(actual, expected, `${code} ${key}`);
      }
    });

    it(`${code}: has no empty messages and only trusted markup`, () => {
      for (const [key, value] of Object.entries(catalog)) {
        assert.ok(typeof value === 'string' && value.trim().length > 0, `${code} ${key} is empty`);
        const tags = [...value.matchAll(/<\/?([a-z]+)[^>]*>/g)];
        if (key.endsWith('Html')) {
          for (const [tag, name] of tags) {
            assert.ok(['strong', 'em', 'kbd', 'span'].includes(name), `${code} ${key}: <${name}> not allowed`);
            if (name === 'span' && !tag.startsWith('</')) assert.equal(tag, '<span class="legend-crash">', `${code} ${key}`);
          }
        } else {
          assert.equal(tags.length, 0, `${code} ${key} contains markup but is not an *Html key`);
        }
      }
    });
  }

  it('has a message for every error code the server, the engine and the client can produce', () => {
    for (const code of [...Object.values(ErrorCode), ...Object.values(EngineErrors), ...CLIENT_ERROR_CODES]) {
      assert.ok(hasMessage(`error.${code}`), `missing error.${code}`);
    }
  });
});

describe('message keys used by the page and the code', () => {
  const html = readFileSync(path.join(CLIENT_DIR, 'index.html'), 'utf8');
  const js = readdirSync(path.join(CLIENT_DIR, 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(path.join(CLIENT_DIR, 'js', f), 'utf8'))
    .join('\n');

  const htmlKeys = [
    ...[...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(';').map((pair) => pair.split(':')[1].trim())),
  ];
  // Any quoted string in the code that looks like a message key (t('…'), tn('…'), maps, ternaries).
  const codeKeys = [...js.matchAll(/'([a-z]+\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.js'));
  /** Families looked up with a computed key, e.g. t(`level.${level}`). */
  const DYNAMIC = ['error.', 'level.', 'conn.', 'direction.', 'track.'];

  it('every key used in index.html exists', () => {
    for (const key of htmlKeys) assert.ok(hasMessage(key), `index.html uses unknown key "${key}"`);
  });

  it('every key used in the client code exists (or is a plural base)', () => {
    assert.ok(codeKeys.length > 100, 'found the keys used in the code');
    for (const key of codeKeys) {
      assert.ok(hasMessage(key) || hasMessage(`${key}.other`), `code uses unknown key "${key}"`);
    }
  });

  it('every catalog key is used somewhere', () => {
    const used = new Set([...htmlKeys, ...codeKeys]);
    for (const key of Object.keys(en)) {
      const base = key.replace(/\.(zero|one|two|few|many|other)$/, '');
      const isUsed = used.has(key) || used.has(base) || DYNAMIC.some((prefix) => key.startsWith(prefix));
      assert.ok(isUsed, `catalog key "${key}" is never used`);
    }
  });
});

describe('lookup', () => {
  it('interpolates placeholders and leaves unknown ones visible', () => {
    assert.equal(t('game.round', { n: 7 }), 'Round 7');
    assert.equal(t('game.round'), 'Round {n}');
    setLanguage('es');
    assert.equal(t('game.playerTurn', { name: 'Ana' }), 'Turno de Ana');
  });

  it('falls back to English, then to the key itself', () => {
    setLanguage('it');
    assert.equal(t('no.such.key'), 'no.such.key');
    assert.equal(tn('no.such.plural', 2), 'no.such.plural');
  });

  it('chooses plural forms with each language’s rules, including a zero form', () => {
    assert.deepEqual([0, 1, 2].map((n) => tn('gameover.crashes', n)), ['no crashes', '1 crash', '2 crashes']);
    setLanguage('pt');
    assert.deepEqual([0, 1, 2].map((n) => tn('gameover.crashes', n)), ['nenhuma batida', '1 batida', '2 batidas']);
    setLanguage('it');
    assert.deepEqual([1, 3].map((n) => tn('game.laps', n)), ['1 giro', '3 giri']);
    setLanguage('es');
    assert.equal(tn('lobby.lastRaceWon', 31, { name: 'Ana' }), '🏁 Última carrera: ganó Ana en 31 turnos.');
  });

  it('matches browser language preferences', () => {
    assert.equal(matchLanguage(['pt-BR', 'en-US']), 'pt');
    assert.equal(matchLanguage(['fr-FR', 'it-IT']), 'it');
    assert.equal(matchLanguage(['es_MX']), 'es');
    assert.equal(matchLanguage(['de-DE']), 'en');
    assert.equal(matchLanguage([]), 'en');
    assert.equal(matchLanguage(undefined), 'en');
  });

  it('formats ordinals per language', () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 111].map(formatOrdinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '111th']);
    setLanguage('es');
    assert.equal(ordinal(1), '1.º');
    setLanguage('pt');
    assert.equal(ordinal(2), '2º');
    setLanguage('it');
    assert.equal(ordinal(3), '3º');
  });

  it('notifies listeners on real changes only', () => {
    const seen = [];
    const off = onLanguageChange((code) => seen.push(code));
    assert.equal(setLanguage('es'), true);
    assert.equal(setLanguage('es'), false, 'no change');
    assert.equal(setLanguage('klingon'), false, 'unsupported');
    off();
    setLanguage('it');
    assert.deepEqual(seen, ['es']);
    assert.equal(getLanguage(), 'it');
  });

  it('translates error codes and keeps the original text for unknown ones', () => {
    assert.equal(errorMessage('ROOM_FULL', 'x'), 'That room is full.');
    setLanguage('pt');
    assert.equal(errorMessage('ROOM_FULL', 'x'), 'Essa sala está cheia.');
    assert.equal(errorMessage('SOMETHING_NEW', 'Server said so.'), 'Server said so.');
    assert.equal(errorMessage(undefined), 'Algo deu errado.');
  });
});

describe('game text in every language', () => {
  const move = { from: { x: 1, y: 1 }, target: { x: 3, y: 1 }, to: { x: 3, y: 1 }, velocity: { x: 2, y: 0 }, crash: null, lapDelta: 0, note: null, outcome: 'moved' };
  const expected = {
    en: ['Ana → (3, 1), speed 2', 'Ana crashes into the wall', 'Ana completes lap 1 of 2', 'Move to (5, 6), speed 3', 'up-left', 'Hard'],
    es: ['Ana → (3, 1), velocidad 2', 'Ana choca contra el muro', 'Ana completa la vuelta 1 de 2', 'Ir a (5, 6), velocidad 3', 'arriba a la izquierda', 'Difícil'],
    pt: ['Ana → (3, 1), velocidade 2', 'Ana bate no muro', 'Ana completa a volta 1 de 2', 'Ir para (5, 6), velocidade 3', 'para cima e à esquerda', 'Difícil'],
    it: ['Ana → (3, 1), velocità 2', 'Ana finisce contro il muro', 'Ana completa il giro 1 di 2', 'Vai a (5, 6), velocità 3', 'su a sinistra', 'Difficile'],
  };
  for (const [code, [moved, crashed, lap, option, direction, hard]] of Object.entries(expected)) {
    it(code, () => {
      setLanguage(code);
      const race = { laps: 2, lapProgress: 1 };
      assert.equal(describeMove(move, 'Ana', race), moved);
      assert.equal(describeMove({ ...move, outcome: 'crashed', crash: 'wall' }, 'Ana', race), crashed);
      assert.equal(describeMove({ ...move, lapDelta: 1 }, 'Ana', race), lap);
      assert.equal(describeOption({ target: { x: 5, y: 6 }, velocity: { x: 2, y: -3 }, outcome: 'move', crash: null }), option);
      assert.equal(directionName(0), direction);
      assert.equal(levelLabel('hard'), hard);
    });
  }
});
