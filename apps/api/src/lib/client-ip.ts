import type { Context } from 'hono';

/**
 * The client address, as far as the proxy in front of this application
 * reports it.
 *
 * Both headers are supplied by whatever sits in front, so neither is
 * trustworthy on its own — a client can send `x-forwarded-for` directly if the
 * deployment exposes the application without a proxy. It is recorded as
 * evidence for an investigation rather than used to make an access decision,
 * which is the only use that tolerates a spoofable value.
 *
 * The left-most entry of `x-forwarded-for` is the original client; the rest are
 * intermediaries appended on the way through.
 */
export function clientIpFromHeaders(headers: Headers | undefined): string | null {
  if (!headers) return null;
  const cloudflare = headers.get('cf-connecting-ip')?.trim();
  if (cloudflare) return cloudflare;

  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;

  const real = headers.get('x-real-ip')?.trim();
  return real || null;
}

/** Hono adapter; authentication hooks use the same resolver with raw Headers. */
export function clientIp(c: Context): string | null {
  return clientIpFromHeaders(c.req.raw.headers);
}
