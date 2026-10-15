import { describe, expect, it } from 'vitest';
import { ApiError, api, apiErrorMessage, sameOriginApiUrl } from '../../src/lib/api-client';

describe('apiErrorMessage', () => {
  it('displays API errors and preserves caller-specific fallback copy for other failures', () => {
    expect(apiErrorMessage(new ApiError(403, 'FORBIDDEN', 'Access denied'), 'Try again')).toBe(
      'Access denied',
    );
    for (const error of [new Error('Internal detail'), null, undefined, 'Internal detail']) {
      expect(apiErrorMessage(error, 'Try again')).toBe('Try again');
    }
  });
});

describe('Retry-After on a refusal', () => {
  async function refusedWith(headers: Record<string, string>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many lookups.' } }),
        {
          status: 429,
          headers,
        },
      )) as typeof fetch;
    Object.assign(globalThis, { window: { location: { origin: 'http://localhost' } } });
    try {
      await api.get('/groups/managed');
      return null;
    } catch (error) {
      return error as ApiError;
    } finally {
      globalThis.fetch = original;
      Reflect.deleteProperty(globalThis, 'window');
    }
  }

  it('is on the error, in seconds, so a page can say how long to wait', async () => {
    const error = await refusedWith({ 'retry-after': '37' });
    expect(error?.status).toBe(429);
    expect(error?.retryAfterSeconds).toBe(37);
  });

  it('is absent when the header is missing or not a number of seconds', async () => {
    expect((await refusedWith({}))?.retryAfterSeconds).toBeUndefined();
    expect(
      (await refusedWith({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))?.retryAfterSeconds,
    ).toBeUndefined();
  });
});

describe('sameOriginApiUrl', () => {
  it('keeps API paths and query strings on the current origin', () => {
    expect(sameOriginApiUrl('/threads?archived=false', 'https://chat.example.edu')).toBe(
      '/api/threads?archived=false',
    );
  });

  it.each(['https://evil.example/path', '//evil.example/path', '\\evil.example', 'threads'])(
    'rejects a non-path input: %s',
    (path) => {
      expect(() => sameOriginApiUrl(path, 'https://chat.example.edu')).toThrow(
        'same-origin absolute path',
      );
    },
  );

  it('rejects fragments that should never be sent to the API', () => {
    expect(() => sameOriginApiUrl('/threads#private', 'https://chat.example.edu')).toThrow(
      'same-origin absolute path',
    );
  });
});
