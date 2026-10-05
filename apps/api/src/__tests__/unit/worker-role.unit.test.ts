import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ role: 'worker' as string | undefined, select: vi.fn() }));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return { ...original, loadEnv: () => ({ ...original.loadEnv(), OCI_ROLE: mocks.role }) };
});
vi.mock('../../db/index.js', () => ({ sql: mocks.select }));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { parseEnv } from '../../config/env.js';
import { beginDrain, resetDrainForTests } from '../../lib/drain.js';
import { processRole, runsBackgroundJobs } from '../../lib/role.js';
import { readiness } from '../../routes/health.js';
import { createWorkerApp } from '../../worker-app.js';

const base = {
  DATABASE_URL: 'postgres://test-only',
  AUTH_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: 'b'.repeat(32),
};

afterEach(() => {
  resetDrainForTests();
});

describe('OCI_ROLE', () => {
  it('defaults to all, accepts web and worker, and refuses anything else', () => {
    expect(parseEnv(base).OCI_ROLE).toBe('all');
    expect(parseEnv({ ...base, OCI_ROLE: '' }).OCI_ROLE).toBe('all');
    expect(parseEnv({ ...base, OCI_ROLE: 'web' }).OCI_ROLE).toBe('web');
    expect(parseEnv({ ...base, OCI_ROLE: 'worker' }).OCI_ROLE).toBe('worker');
    expect(() => parseEnv({ ...base, OCI_ROLE: 'jobs' })).toThrow(/OCI_ROLE/);
  });

  it('runs background jobs everywhere but on a web replica', () => {
    mocks.role = 'web';
    expect([processRole(), runsBackgroundJobs()]).toEqual(['web', false]);
    mocks.role = 'worker';
    expect([processRole(), runsBackgroundJobs()]).toEqual(['worker', true]);
    // An environment stub without a role behaves as the default.
    mocks.role = undefined;
    expect([processRole(), runsBackgroundJobs()]).toEqual(['all', true]);
  });
});

describe('what a worker serves', () => {
  it('answers liveness and readiness, naming its role', async () => {
    mocks.role = 'worker';
    mocks.select.mockResolvedValue([{ '?column?': 1 }]);
    const app = createWorkerApp();
    expect((await app.request('/api/health/live')).status).toBe(200);
    const ready = await app.request('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ok', role: 'worker' });
  });

  it('rides out a short database outage, is not ready after a long one, or once it drains', async () => {
    mocks.role = 'worker';
    const app = createWorkerApp();
    // A failover: every replica's database is briefly unreachable. Readiness
    // stays 200 (degraded), so they are not all taken out of rotation at once.
    mocks.select.mockRejectedValueOnce(new Error('down'));
    const brief = await app.request('/api/health/ready');
    expect(brief.status).toBe(200);
    expect(await brief.json()).toMatchObject({ status: 'degraded', checks: { database: 'error' } });
    const saved = readiness.databaseGraceMs;
    readiness.databaseGraceMs = 0;
    try {
      mocks.select.mockRejectedValueOnce(new Error('still down'));
      expect((await app.request('/api/health/ready')).status).toBe(503);
    } finally {
      readiness.databaseGraceMs = saved;
    }
    // Back: ready, and the outage clock resets.
    mocks.select.mockResolvedValue([{ '?column?': 1 }]);
    expect(await (await app.request('/api/health/ready')).json()).toEqual({
      status: 'ok',
      role: 'worker',
      checks: { database: 'ok' },
    });
    beginDrain('SIGTERM');
    const draining = await app.request('/api/health/ready');
    expect(draining.status).toBe(503);
    expect(await draining.json()).toMatchObject({ status: 'draining', role: 'worker' });
    expect((await app.request('/api/health/live')).status).toBe(200);
  });

  it('serves no API routes', async () => {
    const app = createWorkerApp();
    for (const path of ['/api/threads', '/api/chat', '/api/admin/health', '/']) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: 'NOT_FOUND', message: expect.stringContaining('OCI_ROLE=worker') },
      });
    }
  });

  it('serves /metrics as an API replica does (off without a scrape token)', async () => {
    const response = await createWorkerApp().request('/metrics');
    expect(response.status).toBe(404);
  });
});
