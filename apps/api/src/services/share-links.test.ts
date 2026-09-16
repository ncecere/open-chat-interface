import { describe, expect, it } from 'vitest';
import { sanitizePublicParts } from './share-links.js';

describe('unit: sanitizePublicParts', () => {
  it('keeps public text and safe sources while stripping private parts and attachments', () => {
    expect(
      sanitizePublicParts([
        { type: 'text', text: 'Public answer' },
        { type: 'reasoning', text: 'private chain of thought' },
        { type: 'data-attachment', data: { url: '/api/attachments/private/content' } },
        { type: 'tool-result', output: { credential: 'secret' } },
        {
          type: 'source-url',
          sourceId: 'attacker-controlled',
          url: 'https://example.com/result?q=public&token=secret#private',
          title: 'Example',
        },
        { type: 'source-url', url: 'javascript:alert(1)' },
      ]),
    ).toEqual([
      { type: 'text', text: 'Public answer' },
      {
        type: 'source-url',
        sourceId: 'source-5',
        url: 'https://example.com/result?q=public',
        title: 'Example',
      },
    ]);
  });

  it('redacts common credentials from public text', () => {
    const [part] = sanitizePublicParts([
      {
        type: 'text',
        text: 'Authorization: Bearer top-secret\napi_key=sk-abcdefghijklmnopqrstuvwxyz123456',
      },
    ]);

    expect(part).toEqual({
      type: 'text',
      text: 'Authorization: Bearer [REDACTED]\napi_key=[REDACTED]',
    });
  });

  it('strips URL credentials, fragments, and secret-like query parameters', () => {
    expect(
      sanitizePublicParts([
        {
          type: 'source-url',
          url: 'https://user:password@example.com/path?query=public&access_token=secret#private',
          title: 'password=hunter2',
        },
      ]),
    ).toEqual([
      {
        type: 'source-url',
        sourceId: 'source-1',
        url: 'https://example.com/path?query=public',
        title: 'password=[REDACTED]',
      },
    ]);
  });

  it('omits invalid sources and non-string text, and bounds public content', () => {
    expect(
      sanitizePublicParts([
        { type: 'text', text: 42 },
        { type: 'source-url', url: null },
        { type: 'source-url', url: 'not a URL' },
        { type: 'source-url', url: `https://example.com/${'x'.repeat(2048)}` },
        { type: 'source-url', url: 'http://example.com/', title: '' },
        { type: 'source-url', url: 'https://example.com/', title: 42 },
        { type: 'text', text: 'x'.repeat(100_001) },
        { type: 'source-url', url: 'https://example.com/', title: 'x'.repeat(501) },
      ]),
    ).toEqual([
      { type: 'source-url', sourceId: 'source-5', url: 'http://example.com/' },
      { type: 'source-url', sourceId: 'source-6', url: 'https://example.com/' },
      { type: 'text', text: 'x'.repeat(100_000) },
      {
        type: 'source-url',
        sourceId: 'source-8',
        url: 'https://example.com/',
        title: 'x'.repeat(500),
      },
    ]);
  });

  it('fails closed for malformed containers, non-HTTP URLs, and unknown parts', () => {
    expect(sanitizePublicParts(null)).toEqual([]);
    expect(sanitizePublicParts({ type: 'text', text: 'not an array' })).toEqual([]);
    expect(
      sanitizePublicParts([
        null,
        'text',
        { type: 'source-url', url: 'data:text/html,secret' },
        { type: 'source-document', url: 'https://example.com/private.pdf' },
      ]),
    ).toEqual([]);
  });
});
