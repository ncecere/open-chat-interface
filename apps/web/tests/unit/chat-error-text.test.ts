import { describe, expect, it } from 'vitest';
import { chatErrorText } from '../../src/lib/api-client';

describe('chat error text', () => {
  it('shows the message of an API error body instead of its JSON', () => {
    const body = JSON.stringify({
      error: { code: 'PROVIDER_ERROR', message: 'SerpApi rejected the web search API key.' },
    });
    expect(chatErrorText(new Error(body))).toBe('SerpApi rejected the web search API key.');
  });

  it('says a broken connection in plain words, not in the browser’s (#162)', () => {
    for (const text of [
      'network error',
      'Failed to fetch',
      'NetworkError when attempting to fetch resource.',
      'Load failed',
      'The network connection was lost.',
    ])
      expect(chatErrorText(new TypeError(text))).toBe('The connection to the server was lost.');
  });

  it('leaves other messages as they are', () => {
    expect(chatErrorText(new Error('Fetching the page failed'))).toBe('Fetching the page failed');
    expect(chatErrorText(new Error('{"unexpected":true}'))).toBe('{"unexpected":true}');
  });
});
