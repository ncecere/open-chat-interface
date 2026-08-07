import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashToken, safeCompare } from '../../lib/crypto.js';

describe('unit: authenticated secret encryption', () => {
  it.each(['', 'short secret', 'κρυπτογράφηση\nwith unicode and newlines'])(
    'round-trips plaintext without storing it directly',
    (plaintext) => {
      const encrypted = encryptSecret(plaintext);

      expect(encrypted).not.toContain(plaintext || 'impossible-marker');
      expect(decryptSecret(encrypted)).toBe(plaintext);
    },
  );

  it('uses a fresh IV for every encryption', () => {
    expect(encryptSecret('same secret')).not.toBe(encryptSecret('same secret'));
  });

  it('rejects any authenticated payload tampering', () => {
    const raw = Buffer.from(encryptSecret('sensitive credential'), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;

    expect(() => decryptSecret(raw.toString('base64'))).toThrow();
  });

  it.each(['', 'not base64!', Buffer.alloc(12).toString('base64')])(
    'rejects malformed or truncated ciphertext',
    (payload) => {
      expect(() => decryptSecret(payload)).toThrow();
    },
  );
});

describe('unit: token comparison helpers', () => {
  it('hashes deterministically and compares only exact values', () => {
    expect(hashToken('token')).toBe(hashToken('token'));
    expect(safeCompare('same', 'same')).toBe(true);
    expect(safeCompare('same', 'different')).toBe(false);
    expect(safeCompare('short', 'longer')).toBe(false);
  });
});
