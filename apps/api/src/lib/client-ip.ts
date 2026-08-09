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
export function clientIp(c: Context): string | null {
  const cloudflare = c.req.header('cf-connecting-ip')?.trim();
  if (cloudflare) return cloudflare;

  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;

  const real = c.req.header('x-real-ip')?.trim();
  return real || null;
}
