import { createHmac } from 'node:crypto';

/**
 * RFC 6238 (TOTP) on RFC 4226 (HOTP) with node:crypto, for tests: the library
 * under test must not be its own oracle. SHA-1, 6 digits and 30 seconds are
 * what authenticator apps use and what Better Auth's twoFactor plugin checks;
 * the API's unit test checks apps/api/test/totp.ts, of which this is a copy
 * (Playwright runs in Node, and the two apps share no test code), against the
 * RFC's Appendix B vectors.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Case, spaces, hyphens and `=` padding are ignored, as authenticator apps do. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
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

/** The `secret` parameter of an `otpauth://totp/...` link (base32, as the link carries it). */
export function secretFromUri(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'otpauth:') throw new Error('Not an otpauth link');
  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error('The otpauth link has no secret');
  return secret;
}

export interface TotpOptions {
  /** Milliseconds since the epoch; now by default. */
  time?: number;
  /** Whole steps to move from `time` (+1 is the next code, -1 the previous one). */
  stepOffset?: number;
  digits?: number;
  period?: number;
}

/** The code for a base32 secret. */
export function totp(secret: string, options: TotpOptions = {}): string {
  const period = options.period ?? 30;
  const digits = options.digits ?? 6;
  const counter =
    Math.floor((options.time ?? Date.now()) / 1000 / period) + (options.stepOffset ?? 0);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = hash[hash.length - 1]! & 0x0f;
  const binary =
    ((hash[offset]! & 0x7f) << 24) |
    (hash[offset + 1]! << 16) |
    (hash[offset + 2]! << 8) |
    hash[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}
