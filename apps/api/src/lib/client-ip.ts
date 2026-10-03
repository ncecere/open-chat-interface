import { isIP } from 'node:net';
import type { Context } from 'hono';

/**
 * The client address, as the proxy directly in front of the API reports it.
 *
 * In the bundled deployment that proxy is the web container's Caddy. Caddy
 * replaces `X-Forwarded-For` with the single client address it determined —
 * the connecting peer, or, for peers listed in `TRUSTED_PROXIES`, the address
 * those proxies forwarded — and removes `CF-Connecting-IP` and `X-Real-IP`,
 * which a client could otherwise send straight through (docker/Caddyfile).
 *
 * So the API trusts that one header and, of its entries, only the right-most:
 * the one the nearest proxy wrote. Anything to its left arrived from further
 * out and may be whatever the client sent. A value that is not an IP address
 * is not recorded.
 *
 * Better Auth reads the same header for the address on sessions and for its
 * own limits, and accepts it only as a single address, which is what Caddy
 * sends.
 */
export function clientIpFromHeaders(headers: Headers | undefined): string | null {
  const entries = headers
    ?.get('x-forwarded-for')
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const nearest = entries?.at(-1);
  return nearest && isIP(nearest) ? nearest : null;
}

/** Hono adapter; authentication hooks use the same resolver with raw Headers. */
export function clientIp(c: Context): string | null {
  return clientIpFromHeaders(c.req.raw.headers);
}
