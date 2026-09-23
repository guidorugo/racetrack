import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ClientMessage,
  DEFAULT_ROOM_SETTINGS,
  ErrorCode,
  MAX_MESSAGE_BYTES,
  normalizeRoomCode,
  parseClientMessage,
  parseServerMessage,
  validateRoomSettings,
} from '../src/shared/protocol.js';
import { sanitizeName } from '../src/shared/validation.js';

describe('parseClientMessage', () => {
  const valid = [
    { type: 'create_room', name: 'Ada' },
    { type: 'create_room', name: 'Ada', settings: { laps: 2 } },
    { type: 'join_room', code: 'ABCDE', name: 'Bob' },
    { type: 'resume', code: 'ABCDE', playerId: 'p1', token: 'secret' },
    { type: 'leave_room' },
    { type: 'add_bot', level: 'hard' },
    { type: 'remove_player', playerId: 'p2' },
    { type: 'update_settings', settings: { laps: 3 } },
    { type: 'start_game' },
    { type: 'move', turn: 12, acceleration: { x: 1, y: -1 } },
    { type: 'ping' },
  ];
  for (const msg of valid) {
    it(`accepts ${msg.type}`, () => {
      const result = parseClientMessage(JSON.stringify(msg));
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.message, msg);
    });
  }

  it('covers every client message type', () => {
    assert.deepEqual(new Set(valid.map((m) => m.type)), new Set(Object.values(ClientMessage)));
  });

  it('drops unknown extra fields', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'ping', evil: true }));
    assert.deepEqual(result, { ok: true, message: { type: 'ping' } });
  });

  const invalid = [
    ['non-string input', null, ErrorCode.BAD_MESSAGE],
    ['invalid JSON', '{nope', ErrorCode.BAD_MESSAGE],
    ['JSON array', '[1,2]', ErrorCode.BAD_MESSAGE],
    ['JSON primitive', '42', ErrorCode.BAD_MESSAGE],
    ['missing type', '{"name":"x"}', ErrorCode.BAD_MESSAGE],
    ['unknown type', '{"type":"hack"}', ErrorCode.UNKNOWN_TYPE],
    ['prototype key as type', '{"type":"__proto__"}', ErrorCode.UNKNOWN_TYPE],
    ['missing field', '{"type":"join_room","code":"ABCDE"}', ErrorCode.BAD_MESSAGE],
    ['wrong field type', '{"type":"move","turn":"3","acceleration":{"x":0,"y":0}}', ErrorCode.BAD_MESSAGE],
    ['fractional turn', '{"type":"move","turn":1.5,"acceleration":{"x":0,"y":0}}', ErrorCode.BAD_MESSAGE],
    ['array instead of object', '{"type":"move","turn":1,"acceleration":[0,0]}', ErrorCode.BAD_MESSAGE],
    ['overlong string', JSON.stringify({ type: 'create_room', name: 'x'.repeat(300) }), ErrorCode.BAD_MESSAGE],
    ['oversized message', JSON.stringify({ type: 'ping', pad: 'x'.repeat(MAX_MESSAGE_BYTES) }), ErrorCode.BAD_MESSAGE],
  ];
  for (const [name, raw, code] of invalid) {
    it(`rejects ${name}`, () => {
      const result = parseClientMessage(raw);
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.equal(typeof result.error, 'string');
    });
  }
});

describe('parseServerMessage', () => {
  it('accepts known types and rejects the rest', () => {
    assert.ok(parseServerMessage('{"type":"room","room":{}}').ok);
    assert.equal(parseServerMessage('{"type":"weird"}').ok, false);
    assert.equal(parseServerMessage('garbage').ok, false);
    assert.equal(parseServerMessage(42).ok, false);
  });
});

describe('room codes', () => {
  it('normalises case, spaces and dashes', () => {
    assert.equal(normalizeRoomCode(' abc-d2 '), 'ABCD2');
    assert.equal(normalizeRoomCode('KXQPZ'), 'KXQPZ');
  });
  it('rejects malformed codes', () => {
    for (const bad of ['ABCD', 'ABCDEF', 'ABCD0', 'ABCDI', 'AB$DE', 42, null]) {
      assert.equal(normalizeRoomCode(bad), null, String(bad));
    }
  });
});

describe('room settings', () => {
  it('fills in defaults', () => {
    assert.deepEqual(validateRoomSettings(undefined), { ok: true, settings: { ...DEFAULT_ROOM_SETTINGS } });
  });
  it('merges partial updates onto a base', () => {
    const r = validateRoomSettings({ laps: 3, finishMode: 'all' }, { trackId: 'oval', laps: 1, finishMode: 'first', turnTimeLimit: 30 });
    assert.deepEqual(r, { ok: true, settings: { trackId: 'oval', laps: 3, finishMode: 'all', turnTimeLimit: 30 } });
  });
  for (const bad of [{ laps: 0 }, { laps: 4 }, { laps: '2' }, { turnTimeLimit: 45 }, { finishMode: 'never' }, { trackId: 'moon' }, 'fast', [1]]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      const r = validateRoomSettings(bad);
      assert.equal(r.ok, false);
      assert.equal(typeof r.error, 'string');
    });
  }
});

describe('sanitizeName', () => {
  it('cleans and truncates names', () => {
    assert.equal(sanitizeName('  Speedy   Gonzales '), 'Speedy Gonzales');
    assert.equal(sanitizeName('A​B‮C\u0007'), 'ABC');
    assert.equal(sanitizeName('x'.repeat(50)), 'x'.repeat(20));
    assert.equal(sanitizeName('🏎️'.repeat(30)).length <= 40, true); // counts code points, never splits them
  });
  it('never returns half an emoji (unpaired surrogates)', () => {
    assert.equal(sanitizeName('\u200b'.repeat(159) + '😀'), null);
    assert.equal(sanitizeName('Ann\ud83d'), 'Ann');
    const name = sanitizeName('😀'.repeat(30));
    assert.ok(name.isWellFormed());
  });

  it('rejects empty or non-string names', () => {
    for (const bad of ['', '   ', '​​', null, 42, {}]) assert.equal(sanitizeName(bad), null);
  });
});
