import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIp, clientIpFromHeaders } from '../../lib/client-ip.js';

/**
 * The API sits behind the web container's Caddy, which replaces
 * X-Forwarded-For with the one client address it worked out (trusting outer
 * proxies only when TRUSTED_PROXIES names them) and drops the other
 * client-address headers. So the API trusts that one header, and only the
 * entry the nearest proxy wrote.
 */
describe('proxy-reported client address', () => {
  it('has no address when headers are absent or empty', () => {
    expect(clientIpFromHeaders(undefined)).toBeNull();
    expect(clientIpFromHeaders(new Headers())).toBeNull();
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': ' , ' }))).toBeNull();
  });

  it('takes the address the proxy in front wrote', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': ' 192.0.2.2 ' }))).toBe(
      '192.0.2.2',
    );
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '2001:db8::7' }))).toBe(
      '2001:db8::7',
    );
  });

  it('ignores entries a client could have put ahead of the proxy', () => {
    // A proxy that appends rather than replaces: the left-most entry is
    // whatever the client sent; the right-most is what the proxy saw.
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': '198.51.100.66, 192.0.2.4' })),
    ).toBe('192.0.2.4');
  });

  it('never trusts headers a client can send straight through the proxy', () => {
    expect(
      clientIpFromHeaders(
        new Headers({
          'cf-connecting-ip': '198.51.100.66',
          'x-real-ip': '198.51.100.67',
          'x-forwarded-for': '192.0.2.2',
        }),
      ),
    ).toBe('192.0.2.2');
    expect(clientIpFromHeaders(new Headers({ 'cf-connecting-ip': '198.51.100.66' }))).toBeNull();
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '198.51.100.67' }))).toBeNull();
  });

  it('records nothing rather than something that is not an address', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'unknown' }))).toBeNull();
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '192.0.2.1, <script>' }))).toBe(
      null,
    );
  });

  it('uses the same resolver for Hono and raw authentication headers', async () => {
    const app = new Hono();
    app.get('/', (c) => c.json({ address: clientIp(c) }));
    const headers = new Headers({ 'x-forwarded-for': '192.0.2.5, 192.0.2.6' });
    const response = await app.request('/', { headers });
    expect(await response.json()).toEqual({ address: '192.0.2.6' });
  });
});
