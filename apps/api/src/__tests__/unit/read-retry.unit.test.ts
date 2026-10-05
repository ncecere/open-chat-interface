import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { noteConnectionClosed } from '../../lib/db-connection.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { lostConnectionDuring, withReadRetry } from '../../middleware/read-retry.js';

const lost = () => Object.assign(new Error('terminating connection'), { code: '57P01' });

/**
 * The request pipeline's answer to a database failover: reads run once more,
 * writes are reported as retryable with a 500 (503 means a draining replica).
 */
describe('read retry after a lost database connection', () => {
  let failures: number;
  let calls: number;
  let fetch: (request: Request) => Promise<Response>;

  beforeEach(() => {
    failures = 1;
    calls = 0;
    const app = new Hono();
    app.onError(errorHandler);
    app.on(['GET', 'POST', 'HEAD'], '/thing', (c) => {
      calls++;
      if (failures-- > 0) throw lost();
      return c.json({ ok: true });
    });
    app.get('/broken', () => {
      calls++;
      throw new Error('a bug');
    });
    app.get('/better-auth', () => {
      calls++;
      // A library that swallows the cause; the pool saw the connection go.
      if (calls === 1) {
        noteConnectionClosed();
        throw new Error('Failed to get session');
      }
      return new Response('ok');
    });
    app.on(['GET', 'POST'], '/library', () => {
      calls++;
      // A library answering with its own 500 (Better Auth's endpoints do).
      if (calls === 1 || failures > 0) {
        noteConnectionClosed();
        return new Response('{"message":"internal"}', { status: 500 });
      }
      return new Response('ok');
    });
    fetch = withReadRetry((request: Request) => Promise.resolve(app.fetch(request)));
  });

  it('runs a read once more and answers it', async () => {
    const response = await fetch(new Request('http://oci.test/thing'));
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('runs it only once more', async () => {
    failures = 2;
    const response = await fetch(new Request('http://oci.test/thing'));
    expect(response.status).toBe(500);
    expect(response.headers.get('x-oci-retryable')).toBe('database-connection');
    expect(calls).toBe(2);
  });

  it('never repeats a write: 500 with retryable, Retry-After, and not 503', async () => {
    const response = await fetch(new Request('http://oci.test/thing', { method: 'POST' }));
    expect(response.status).toBe(500);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', retryable: true },
    });
    expect(calls).toBe(1);
  });

  it('leaves other server errors alone', async () => {
    const response = await fetch(new Request('http://oci.test/broken'));
    expect(response.status).toBe(500);
    expect(response.headers.get('x-oci-retryable')).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(calls).toBe(1);
  });

  it('counts an unexpected error as a lost connection when the pool lost one during the request', async () => {
    const response = await fetch(new Request('http://oci.test/better-auth'));
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('treats a library’s own 500 during a connection loss the same way', async () => {
    failures = 0;
    expect((await fetch(new Request('http://oci.test/library'))).status).toBe(200);
    expect(calls).toBe(2);
    calls = 0;
    const write = await fetch(new Request('http://oci.test/library', { method: 'POST' }));
    expect(write.status).toBe(500);
    expect(write.headers.get('x-oci-retryable')).toBe('database-connection');
    expect(await write.text()).toBe('{"message":"internal"}');
    expect(calls).toBe(1);
    // A read that fails the same way twice is answered with the second, marked.
    calls = 0;
    failures = 5;
    const read = await fetch(new Request('http://oci.test/library'));
    expect(read.status).toBe(500);
    expect(read.headers.get('x-oci-retryable')).toBe('database-connection');
    expect(calls).toBe(2);
  });

  it('decides from the error alone outside the pipeline', () => {
    expect(lostConnectionDuring(undefined, lost())).toBe(true);
    expect(lostConnectionDuring(undefined, new Error('x'))).toBe(false);
    expect(lostConnectionDuring(new Request('http://oci.test/'), new Error('x'))).toBe(false);
  });
});
