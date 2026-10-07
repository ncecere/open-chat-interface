import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ db: {} }));

const { deriveTitle } = await import('../../services/threads.js');

describe('the title taken from a first message (#100)', () => {
  it('keeps a short message whole, and names an empty one', () => {
    expect(deriveTitle('  Walk   question  ')).toBe('Walk question');
    expect(deriveTitle('   ')).toBe('New Chat');
  });

  it('ends a long one on a whole word, without an ellipsis', () => {
    // The QA walk's examples, previously "…latest stable version o..." and "…contac...".
    expect(
      deriveTitle(
        'Walk search: what is the latest stable version of PostgreSQL, and when was it released?',
      ),
    ).toBe('Walk search: what is the latest stable version of');
    expect(
      deriveTitle(
        'Walk project search: who is the emergency contact for the library building after hours?',
      ),
    ).toBe('Walk project search: who is the emergency contact for the');
  });

  it('drops a trailing comma or dash left at the cut', () => {
    expect(
      deriveTitle('Walk alpha beta gamma delta epsilon zeta eta theta iota, kappa lambda mu nu'),
    ).toBe('Walk alpha beta gamma delta epsilon zeta eta theta iota');
  });

  it('cuts one very long word where it must', () => {
    const url = `https://example.edu/${'a'.repeat(100)}`;
    expect(deriveTitle(url)).toBe(url.slice(0, 60));
  });
});
