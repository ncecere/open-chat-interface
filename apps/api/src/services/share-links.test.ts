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
