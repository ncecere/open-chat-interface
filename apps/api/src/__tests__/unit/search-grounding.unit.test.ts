import { describe, expect, it } from 'vitest';
import { validateSearchEndpoint } from '../../services/search/http.js';
import { buildGroundingContext, normalizeSearchQuery } from '../../services/search/index.js';

describe('web search grounding', () => {
  it('normalizes the exact query retained with the response', () => {
    expect(normalizeSearchQuery('  current\n\tmodel   news  ')).toBe('current model news');
  });

  it('bounds retained and upstream queries', () => {
    expect(normalizeSearchQuery('x'.repeat(2_500))).toHaveLength(2_000);
  });

  it('accepts HTTP(S) provider endpoints, including self-hosted SearXNG', () => {
    expect(validateSearchEndpoint(new URL('https://api.tavily.com/search')).hostname).toBe(
      'api.tavily.com',
    );
    expect(validateSearchEndpoint(new URL('http://searxng:8080/search')).hostname).toBe('searxng');
  });

  it('rejects non-HTTP provider URLs and embedded credentials', () => {
    expect(() => validateSearchEndpoint(new URL('file:///etc/passwd'))).toThrow(
      'must use HTTP or HTTPS',
    );
    expect(() => validateSearchEndpoint(new URL('https://user:secret@example.com/search'))).toThrow(
      'cannot contain credentials',
    );
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
