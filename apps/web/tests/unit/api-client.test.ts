import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorMessage, sameOriginApiUrl } from '../../src/lib/api-client';

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
