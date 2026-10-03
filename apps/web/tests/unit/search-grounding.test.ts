import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { searchGroundingOf } from '../../src/components/chat/search-grounding';

function message(parts: UIMessage['parts']): UIMessage {
  return { id: 'assistant-1', role: 'assistant', parts };
}

describe('search grounding message data', () => {
  it('reads the persisted query, snippets, and result URLs', () => {
    const grounding = searchGroundingOf(
      message([
        {
          type: 'data-search-grounding',
          data: {
            query: 'latest model news',
            results: [
              { title: 'Result', url: 'https://example.com/story', snippet: 'Current details' },
            ],
          },
        } as UIMessage['parts'][number],
      ]),
    );

    expect(grounding).toEqual({
      query: 'latest model news',
      results: [{ title: 'Result', url: 'https://example.com/story', snippet: 'Current details' }],
    });
  });

  it('carries which provider answered, and whether it was the fallback', () => {
    const grounding = searchGroundingOf(
      message([
        {
          type: 'data-search-grounding',
          data: { query: 'q', results: [], provider: 'Brave Search', fallback: true },
        } as UIMessage['parts'][number],
      ]),
    );
    expect(grounding).toEqual({
      query: 'q',
      results: [],
      provider: 'Brave Search',
      fallback: true,
    });

    const first = searchGroundingOf(
      message([
        {
          type: 'data-search-grounding',
          data: { query: 'q', results: [], provider: 'SearXNG', fallback: 'yes' },
        } as UIMessage['parts'][number],
      ]),
    );
    expect(first).toEqual({ query: 'q', results: [], provider: 'SearXNG' });
  });

  it('carries why a search failed, so the reply can say so', () => {
    const grounding = searchGroundingOf(
      message([
        {
          type: 'data-search-grounding',
          data: {
            query: 'nvidia share price',
            results: [],
            error: 'SerpApi rejected the web search API key (HTTP 401).',
          },
        } as UIMessage['parts'][number],
      ]),
    );
    expect(grounding).toEqual({
      query: 'nvidia share price',
      results: [],
      error: 'SerpApi rejected the web search API key (HTTP 401).',
    });
  });

  it('keeps older source-url messages readable without inventing snippets', () => {
    const grounding = searchGroundingOf(
      message([
        {
          type: 'source-url',
          sourceId: 'source-1',
          title: 'Legacy result',
          url: 'https://example.com/legacy',
        },
      ]),
    );

    expect(grounding).toEqual({
      query: null,
      results: [{ title: 'Legacy result', url: 'https://example.com/legacy', snippet: '' }],
    });
  });

  it('returns null when the response was not grounded', () => {
    expect(searchGroundingOf(message([{ type: 'text', text: 'Hello' }]))).toBeNull();
  });
});
