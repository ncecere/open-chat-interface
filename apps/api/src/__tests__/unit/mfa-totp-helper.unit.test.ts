import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, secretFromUri, totp } from '../../../test/totp.js';

/**
 * The test helper that computes authenticator codes, checked against RFC 6238
 * Appendix B (SHA-1, the secret "12345678901234567890", 8 digits), so the
 * library under test is never its own oracle: a wrong helper would make every
 * live MFA test lie.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('RFC 6238 test vectors (Appendix B, SHA-1)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('at T=%i the code is %s', (seconds, expected) => {
    expect(totp(RFC_SECRET, { time: seconds * 1000, digits: 8 })).toBe(expected);
  });

  it('gives the 6-digit code OCI uses (the last 6 of the 8-digit code)', () => {
    expect(totp(RFC_SECRET, { time: 59_000 })).toBe('287082');
  });

  it('moves with the 30 second step', () => {
    expect(totp(RFC_SECRET, { time: 59_000, stepOffset: 1 })).toBe(
      totp(RFC_SECRET, { time: 89_000 }),
    );
  });
});

describe('base32 and otpauth links', () => {
  it('round-trips bytes', () => {
    const bytes = Buffer.from('hello, authenticator');
    expect(Buffer.from(base32Decode(base32Encode(bytes))).toString()).toBe('hello, authenticator');
  });

  it('ignores case, spaces and padding when decoding', () => {
    expect(Buffer.from(base32Decode('mfrg gzdf mztw q===')).toString()).toBe('abcdefgh');
  });

  it('reads the secret from an otpauth link', () => {
    const uri = `otpauth://totp/Issuer:me%40example.test?secret=${RFC_SECRET}&issuer=Issuer&digits=6&period=30`;
    expect(secretFromUri(uri)).toBe(RFC_SECRET);
    expect(() => secretFromUri('https://example.test')).toThrow();
  });
});
