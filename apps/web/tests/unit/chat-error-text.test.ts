import { describe, expect, it } from 'vitest';
import { chatErrorText } from '../../src/lib/api-client';

describe('chat error text', () => {
  it('shows the message of an API error body instead of its JSON', () => {
    const body = JSON.stringify({
      error: { code: 'PROVIDER_ERROR', message: 'SerpApi rejected the web search API key.' },
    });
    expect(chatErrorText(new Error(body))).toBe('SerpApi rejected the web search API key.');
  });

  it('leaves other messages as they are', () => {
    expect(chatErrorText(new Error('Failed to fetch'))).toBe('Failed to fetch');
    expect(chatErrorText(new Error('{"unexpected":true}'))).toBe('{"unexpected":true}');
  });
});
