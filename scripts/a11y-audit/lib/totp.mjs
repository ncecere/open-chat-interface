/**
 * RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 s) with node:crypto, so the
 * audit can sign in as an account with two-step verification. The library under test must not
 * be its own oracle; scripts/a11y-audit-totp.test.mjs checks this against the RFC's vectors.
 */

import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** The `secret` of an `otpauth://totp/...` link. */
export function secretFromUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== 'otpauth:') throw new Error('Not an otpauth link');
  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error('The otpauth link has no secret');
  return secret;
}

/**
 * @param {Uint8Array | string} secret raw bytes, or base32 text
 * @param {{ time?: number, stepOffset?: number, digits?: number, period?: number }} [options]
 */
export function totp(secret, { time = Date.now(), stepOffset = 0, digits = 6, period = 30 } = {}) {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  const counter = Math.floor(time / 1000 / period) + stepOffset;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}
