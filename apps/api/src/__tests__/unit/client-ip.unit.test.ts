import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIp, clientIpFromHeaders } from '../../lib/client-ip.js';

describe('proxy-reported client address', () => {
  it('has no address when headers are absent or empty', () => {
    expect(clientIpFromHeaders(undefined)).toBeNull();
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });

  it.each([
    [
      {
        'cf-connecting-ip': ' 192.0.2.1 ',
        'x-forwarded-for': '192.0.2.2',
        'x-real-ip': '192.0.2.3',
      },
      '192.0.2.1',
    ],
    [
      {
        'cf-connecting-ip': ' ',
        'x-forwarded-for': ' 192.0.2.2, 192.0.2.4 ',
        'x-real-ip': '192.0.2.3',
      },
      '192.0.2.2',
    ],
    [{ 'x-forwarded-for': ' , 192.0.2.4', 'x-real-ip': ' 192.0.2.3 ' }, '192.0.2.3'],
    [{ 'x-real-ip': ' ' }, null],
  ] as const)('preserves header precedence and trimming (%j)', (headers, expected) => {
    expect(clientIpFromHeaders(new Headers(headers))).toBe(expected);
  });

  it('uses the same resolver for Hono and raw authentication headers', async () => {
    const app = new Hono();
    app.get('/', (c) => c.json({ address: clientIp(c) }));
    const headers = new Headers({ 'x-forwarded-for': '192.0.2.5, 192.0.2.6' });
    const response = await app.request('/', { headers });
    expect(await response.json()).toEqual({ address: clientIpFromHeaders(headers) });
  });
});
