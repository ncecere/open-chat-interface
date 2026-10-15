import { describe, expect, it } from 'vitest';
import { normalizeClassificationSettings } from '../../services/classification/config.js';
import { listNames } from '../../services/classification/guard.js';
import { decide, type ResolvedClass } from '../../services/classification/resolve.js';

const entry = (id: string, name = id): ResolvedClass => ({
  id,
  name,
  retired: false,
  reasons: ['project'],
  connectorNames: [],
  origins: [],
  locked: false,
});

describe('data classification: the decision', () => {
  const carried = [entry('a'), entry('b')];

  it('allows when everything is approved, warns or blocks by mode otherwise', () => {
    expect(decide('block', carried, new Set(['a', 'b', 'c'])).outcome).toBe('allow');
    expect(decide('block', carried, new Set(['a']))).toMatchObject({
      outcome: 'block',
      missing: [{ id: 'b' }],
    });
    expect(decide('warn', carried, new Set())).toMatchObject({ outcome: 'warn' });
    expect(decide('block', [], new Set()).outcome).toBe('allow');
  });

  it('reads nothing into mode off: no classes, nothing missing', () => {
    expect(decide('off', carried, new Set())).toEqual({
      mode: 'off',
      outcome: 'allow',
      classes: [],
      missing: [],
    });
  });
});

describe('data classification: the setting', () => {
  it('is off, with no approvals, unless it says otherwise', () => {
    const none = { webSearch: [], embeddings: [], reranking: [] };
    for (const stored of [undefined, null, {}, { mode: 'strict' }, { mode: 3 }])
      expect(normalizeClassificationSettings(stored as never)).toEqual({
        mode: 'off',
        services: none,
      });
    expect(
      normalizeClassificationSettings({
        mode: 'block',
        services: { webSearch: ['a', 7, 'b'] as never, embeddings: 'a' as never },
      }),
    ).toEqual({
      mode: 'block',
      services: { webSearch: ['a', 'b'], embeddings: [], reranking: [] },
    });
  });
});

describe('data classification: wording', () => {
  it('lists names in plain English', () => {
    expect(listNames([])).toBe('');
    expect(listNames(['Student records'])).toBe('Student records');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
