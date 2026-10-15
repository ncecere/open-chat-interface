import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, secretFromUri, totp } from './a11y-audit/lib/totp.mjs';

// RFC 6238 Appendix B, SHA-1, secret "12345678901234567890"; the RFC lists 8 digits.
const SECRET = Buffer.from('12345678901234567890');

test('matches the RFC 6238 test vectors', () => {
  assert.equal(totp(SECRET, { time: 59_000, digits: 8 }), '94287082');
  assert.equal(totp(SECRET, { time: 1_111_111_109_000, digits: 8 }), '07081804');
  assert.equal(totp(SECRET, { time: 1_234_567_890_000, digits: 8 }), '89005924');
  assert.equal(totp(SECRET, { time: 59_000 }), '287082');
});

test('a base32 secret and the same bytes give the same code, and a step offset moves on', () => {
  const base32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.deepEqual(Buffer.from(base32Decode(base32)), SECRET);
  assert.equal(totp(base32, { time: 59_000 }), '287082');
  assert.notEqual(totp(base32, { time: 59_000, stepOffset: 1 }), '287082');
});

test('reads the secret from an otpauth link and refuses other links', () => {
  assert.equal(secretFromUri('otpauth://totp/OCI:a?secret=ABC234&issuer=OCI'), 'ABC234');
  assert.throws(() => secretFromUri('https://example.test/?secret=x'), /otpauth/);
  assert.throws(() => secretFromUri('otpauth://totp/x'), /no secret/);
});
