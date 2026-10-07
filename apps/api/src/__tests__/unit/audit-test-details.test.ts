import { describe, expect, it } from 'vitest';
import {
  auditedAddress,
  redactedReason,
  searchTestAuditDetails,
} from '../../services/audit-test-details.js';

/**
 * What a failed Test records (#343) is the server's own wording, stored in an
 * audit log that is exported: so the reason keeps what an administrator needs
 * (the error, the address) and loses anything that could be a credential.
 */
describe('redactedReason', () => {
  it('keeps a reason that holds no secret as it is, on one line', () => {
    expect(redactedReason('connect ECONNREFUSED 172.29.0.2:1026')).toBe(
      'connect ECONNREFUSED 172.29.0.2:1026',
    );
    expect(redactedReason('Invalid login:\n 535 5.7.8 Username and Password not accepted')).toBe(
      'Invalid login: 535 5.7.8 Username and Password not accepted',
    );
  });

  it('removes the user and password of an address', () => {
    const reason = redactedReason(
      'getaddrinfo ENOTFOUND smtp://mailer:p4ss-w0rd@mail.example.test',
    );
    expect(reason).toBe('getaddrinfo ENOTFOUND smtp://[redacted]@mail.example.test');
  });

  it('removes values whose name says they are secret, bearer tokens and key shapes', () => {
    const reason = redactedReason(
      'HTTP 401 for https://api.example.test/search?q=x&api_key=abc123def&format=json; ' +
        'Authorization: Bearer eyJhbGciOi.payload.sig; key sk-live-0123456789abcdef; ' +
        'AKIAABCDEFGHIJKLMNOP; secret_access_key: "s3cr3t/value"',
    );
    expect(reason).not.toMatch(/abc123def|eyJhbGciOi|sk-live|AKIAABCDEFGHIJKLMNOP|s3cr3t/);
    expect(reason).toContain('HTTP 401 for https://api.example.test/search?q=x&api_key=[redacted]');
    expect(reason).toContain('format=json');
  });

  it('removes a long token-like string and any value the caller knows', () => {
    expect(redactedReason('rejected 3f9a1c7e5b2d4f8a9c0e1d2b3a4f5c6d7e8f9a0b')).toBe(
      'rejected [redacted]',
    );
    expect(
      redactedReason('provider said hunter2hunter2 is invalid', ['hunter2hunter2', null]),
    ).toBe('provider said [redacted] is invalid');
  });

  it('drops the values a failed database query was run with', () => {
    expect(
      redactedReason('Failed query: select 1 from "user" where "email" = $1\nparams: a@b.test'),
    ).toBe('Failed query: select 1 from "user" where "email" = $1 params: [redacted]');
  });

  it('is cut to a short line', () => {
    const reason = redactedReason('connection reset '.repeat(100));
    expect(reason.length).toBeLessThanOrEqual(301);
    expect(reason.endsWith('…')).toBe(true);
  });
});

describe('auditedAddress', () => {
  it('keeps where, not who or with what', () => {
    expect(auditedAddress('http://user:pw@127.0.0.1:9/search?token=abc#x')).toBe(
      'http://127.0.0.1:9/search',
    );
    expect(auditedAddress('https://s3.example.test/')).toBe('https://s3.example.test');
    expect(auditedAddress('  ')).toBeNull();
    expect(auditedAddress(null)).toBeNull();
  });
});

describe('searchTestAuditDetails', () => {
  it('names the address only for providers reached at an address, and the reason only on failure', () => {
    expect(
      searchTestAuditDetails(
        { provider: 'searxng', baseUrl: 'http://127.0.0.1:9' },
        { ok: false, message: 'SearXNG did not answer.' },
        [],
      ),
    ).toEqual({ baseUrl: 'http://127.0.0.1:9', reason: 'SearXNG did not answer.' });
    expect(
      searchTestAuditDetails(
        { provider: 'searxng', baseUrl: 'http://127.0.0.1:9' },
        { ok: true, results: 3 },
        [],
      ),
    ).toEqual({ baseUrl: 'http://127.0.0.1:9' });
    expect(
      searchTestAuditDetails(
        { provider: 'serpapi', baseUrl: 'http://ignored.test' },
        { ok: false, message: 'rejected key typed-key' },
        ['typed-key'],
        'fallback',
      ),
    ).toEqual({ fallbackReason: 'rejected key [redacted]' });
  });
});
