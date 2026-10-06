import { createServer, type Server, type Socket } from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Readiness while the database does not answer (#232): its address accepts
 * connections and then says nothing, as an old primary that drops packets
 * during a failover does (or a host whose name takes seconds to fail to
 * resolve). The real postgres.js driver and the real route; only the
 * database behind it is a silent socket.
 */
const state = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('../../db/index.js', () => ({
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

let silent: Server;
const sockets = new Set<Socket>();
let connections = 0;
let client: postgres.Sql;

beforeAll(async () => {
  silent = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const { port } = silent.address() as { port: number };
  // The application pool's own settings: several connections, the driver's
  // default 30 s connect timeout.
  client = postgres(`postgres://oci:x@127.0.0.1:${port}/oci`, { max: 4, onnotice: () => {} });
  state.sql = client;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await client.end({ timeout: 0 });
  await new Promise((resolve) => silent.close(resolve));
});

describe('readiness with a database that does not answer', () => {
  it('answers within its check timeout, reporting the database as failing', async () => {
    const { createWorkerApp } = await import('../../worker-app.js');
    const { readiness } = await import('../../routes/health.js');
    const app = createWorkerApp();
    for (let probe = 0; probe < 3; probe++) {
      const started = Date.now();
      // Before: no answer until the driver's 30 s connect timeout.
      const response = await Promise.race([
        app.request('/api/health/ready'),
        new Promise<'no answer'>((resolve) => setTimeout(() => resolve('no answer'), 3_000)),
      ]);
      const elapsed = Date.now() - started;
      expect(response).not.toBe('no answer');
      expect(elapsed).toBeLessThan(readiness.checkTimeoutMs + 500);
      // Within the outage grace: still in rotation, but degraded.
      expect((response as Response).status).toBe(200);
      expect(await (response as Response).json()).toMatchObject({
        status: 'degraded',
        checks: { database: 'error' },
      });
    }
    // Each probe joined the check still waiting instead of queuing another
    // query, so the pool opened one connection, not one per probe.
    expect(connections).toBe(1);
  }, 15_000);
});
