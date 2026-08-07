import { describe, expect, it } from 'vitest';
import { buildGroundingContext, normalizeSearchQuery } from '../../services/search/index.js';

describe('web search grounding', () => {
  it('normalizes the exact query retained with the response', () => {
    expect(normalizeSearchQuery('  current\n\tmodel   news  ')).toBe('current model news');
  });

  it('bounds retained and upstream queries', () => {
    expect(normalizeSearchQuery('x'.repeat(2_500))).toHaveLength(2_000);
  });

  it('builds numbered context with titles, URLs, and snippets', () => {
    expect(
      buildGroundingContext([
        {
          title: 'Current model news',
          url: 'https://example.com/news',
          snippet: 'A concise result excerpt.',
        },
      ]),
    ).toContain(
      '[1] Current model news\nURL: https://example.com/news\nExcerpt: A concise result excerpt.',
    );
  });
});
