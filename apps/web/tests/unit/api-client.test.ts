import { describe, expect, it } from 'vitest';
import { sameOriginApiUrl } from '../../src/lib/api-client';

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
