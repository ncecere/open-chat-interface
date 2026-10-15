import { describe, expect, it } from 'vitest';
import { formatMessage } from '../../src/lib/i18n/message';
import {
  describeMessage,
  MessageSyntaxError,
  parseMessage,
} from '../../src/lib/i18n/message-parse';

// The ICU subset the catalogs use: {name}, {n, number}, {d, date, short|long|time}
// and {count, plural, ...}. A bad message must never throw at render time.

const en = { locale: 'en' };
const ar = { locale: 'ar' };
const es = { locale: 'es' };

describe('parseMessage', () => {
  it('parses plain text and arguments', () => {
    expect(parseMessage('Hello')).toEqual(['Hello']);
    expect(parseMessage('Hi {name}!')).toEqual(['Hi ', { type: 'arg', name: 'name' }, '!']);
  });

  it('rejects unbalanced braces, unknown types and a plural without other', () => {
    for (const bad of [
      'Hi {name',
      'Hi }',
      'Hi {}',
      '{n, bogus}',
      '{n, plural, one {x}}',
      '{n, plural, other}',
      '{n, number, wat}',
      '{d, date, wat}',
      '{n, plural, one {x} one {y} other {z}}',
    ]) {
      expect(() => parseMessage(bad), bad).toThrow(MessageSyntaxError);
    }
  });

  it('treats a lone apostrophe as text and quotes braces', () => {
    expect(formatMessage("It's {name}'s", { name: 'Ana' }, en)).toBe("It's Ana's");
    expect(formatMessage("Use '{name}' literally", { name: 'Ana' }, en)).toBe(
      'Use {name} literally',
    );
    expect(formatMessage("Two '' make one", {}, en)).toBe("Two ' make one");
  });
});

describe('formatMessage', () => {
  it('fills placeholders and leaves a missing one visible instead of throwing', () => {
    expect(formatMessage('Hello {name}', { name: 'Ana' }, en)).toBe('Hello Ana');
    expect(formatMessage('Hello {name}', {}, en)).toBe('Hello {name}');
    expect(formatMessage('Count {n}', { n: 3 }, en)).toBe('Count 3');
  });

  it('formats numbers and dates with the locale', () => {
    expect(formatMessage('{n, number}', { n: 1234567.5 }, en)).toBe('1,234,567.5');
    expect(formatMessage('{n, number}', { n: 1234567.5 }, es)).toBe(
      new Intl.NumberFormat('es').format(1234567.5),
    );
    expect(formatMessage('{n, number, percent}', { n: 0.25 }, en)).toBe('25%');
    const d = new Date(Date.UTC(2026, 9, 14, 15, 30));
    expect(formatMessage('{d, date, long}', { d }, { ...en, timeZone: 'UTC' })).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(d),
    );
    expect(formatMessage('{d, date, short}', { d }, { ...ar, timeZone: 'UTC' })).toBe(
      new Intl.DateTimeFormat('ar', { dateStyle: 'short', timeZone: 'UTC' }).format(d),
    );
    expect(formatMessage('{d, date, time}', { d }, { ...en, timeZone: 'UTC' })).toBe(
      new Intl.DateTimeFormat('en', { timeStyle: 'short', timeZone: 'UTC' }).format(d),
    );
  });

  it('accepts a timestamp or an ISO string where a date is expected, and survives garbage', () => {
    const iso = '2026-10-14T15:30:00Z';
    const viaDate = formatMessage('{d, date, short}', { d: new Date(iso) }, en);
    expect(formatMessage('{d, date, short}', { d: iso }, en)).toBe(viaDate);
    expect(formatMessage('{d, date, short}', { d: Date.parse(iso) }, en)).toBe(viaDate);
    expect(formatMessage('{d, date, short}', { d: 'not a date' }, en)).toBe('not a date');
    expect(formatMessage('{n, number}', { n: 'abc' }, en)).toBe('abc');
  });

  const files = '{count, plural, one {# file} other {# files}}';

  it('picks English plural forms and formats #', () => {
    expect(formatMessage(files, { count: 1 }, en)).toBe('1 file');
    expect(formatMessage(files, { count: 0 }, en)).toBe('0 files');
    expect(formatMessage(files, { count: 1200 }, en)).toBe('1,200 files');
  });

  it('prefers an exact =N branch and supports an offset', () => {
    const msg = '{n, plural, =0 {nobody} =1 {just you} one {# other} other {# others}}';
    expect(formatMessage(msg, { n: 0 }, en)).toBe('nobody');
    expect(formatMessage(msg, { n: 1 }, en)).toBe('just you');
    expect(formatMessage(msg, { n: 5 }, en)).toBe('5 others');
    const off =
      '{n, plural, offset:1 =0 {nobody} =1 {{who}} one {{who} and # other} other {{who} and # others}}';
    expect(formatMessage(off, { n: 1, who: 'Ana' }, en)).toBe('Ana');
    expect(formatMessage(off, { n: 2, who: 'Ana' }, en)).toBe('Ana and 1 other');
    expect(formatMessage(off, { n: 4, who: 'Ana' }, en)).toBe('Ana and 3 others');
  });

  it('uses Spanish plural rules', () => {
    const msg = '{n, plural, one {# archivo} many {# de archivos} other {# archivos}}';
    expect(formatMessage(msg, { n: 1 }, es)).toBe('1 archivo');
    expect(formatMessage(msg, { n: 3 }, es)).toBe('3 archivos');
    expect(formatMessage(msg, { n: 1_000_000 }, es)).toContain('de archivos');
  });

  it('uses the six Arabic plural forms', () => {
    const msg = '{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}';
    const cases: Array<[number, string]> = [
      [0, 'zero'],
      [1, 'one'],
      [2, 'two'],
      [3, 'few'],
      [10, 'few'],
      [11, 'many'],
      [99, 'many'],
      [100, 'other'],
      [2, 'two'],
      [101, 'other'],
      [102, 'other'],
      [103, 'few'],
      [111, 'many'],
    ];
    for (const [n, expected] of cases)
      expect(formatMessage(msg, { n }, ar), String(n)).toBe(expected);
  });

  it('falls back to other for a non-numeric count', () => {
    expect(formatMessage(files, { count: 'many' }, en)).toBe('many files');
    expect(formatMessage(files, {}, en)).toBe('{count} files');
  });

  it('nests arguments inside plural branches', () => {
    const msg = '{n, plural, one {{name} has # chat} other {{name} has # chats}}';
    expect(formatMessage(msg, { n: 1, name: 'Ana' }, en)).toBe('Ana has 1 chat');
    expect(formatMessage(msg, { n: 2, name: 'Ana' }, en)).toBe('Ana has 2 chats');
  });

  it('never throws on a bad message: returns it unchanged', () => {
    expect(formatMessage('Broken {name', { name: 'x' }, en)).toBe('Broken {name');
    expect(formatMessage('{n, plural, one {x}}', { n: 1 }, en)).toBe('{n, plural, one {x}}');
  });

  it('does not interpret user text passed as a parameter', () => {
    expect(formatMessage('Hello {name}', { name: '{evil, plural, other {x}}' }, en)).toBe(
      'Hello {evil, plural, other {x}}',
    );
  });
});

describe('describeMessage', () => {
  it('lists argument names and types, and plural categories, for the check script', () => {
    expect(
      describeMessage(
        '{who} sent {count, plural, one {# file} other {# files}} on {d, date, short} ({n, number})',
      ),
    ).toEqual({
      args: [
        { name: 'count', type: 'plural' },
        { name: 'd', type: 'date' },
        { name: 'n', type: 'number' },
        { name: 'who', type: 'arg' },
      ],
      plurals: { count: ['one', 'other'] },
    });
  });

  it('collects arguments used inside plural branches', () => {
    expect(
      describeMessage('{n, plural, one {{name} has # chat} other {{name} has # chats}}').args,
    ).toEqual([
      { name: 'n', type: 'plural' },
      { name: 'name', type: 'arg' },
    ]);
  });
});
