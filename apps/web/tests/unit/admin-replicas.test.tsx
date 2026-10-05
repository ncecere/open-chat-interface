// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Replicas } from '../../src/components/admin/operations/replicas';
import { cleanup, renderAdmin } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const now = new Date().toISOString();

describe('System health: replicas (OCI_ROLE)', () => {
  let root: Root | undefined;
  afterEach(async () => {
    if (root) await cleanup(root);
    root = undefined;
    api.get.mockReset();
  });

  it('lists the replicas heard from, with their roles', async () => {
    api.get.mockResolvedValue({
      replicas: {
        role: 'web',
        live: [
          { id: 'a', role: 'web', host: 'api-1', version: '0.11.0', startedAt: now, seenAt: now },
          {
            id: 'b',
            role: 'worker',
            host: 'worker-1',
            version: '0.11.0',
            startedAt: now,
            seenAt: now,
          },
        ],
      },
    });
    ({ root } = await renderAdmin(<Replicas />));
    expect(api.get).toHaveBeenCalledWith('/admin/health');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Replicas');
    expect(text).toContain('api-1');
    expect(text).toContain('Web (API only)');
    expect(text).toContain('worker-1');
    expect(text).toContain('Worker (background jobs)');
  });

  it('explains an empty list, and a deployment without Redis', async () => {
    api.get.mockResolvedValue({ replicas: { role: 'all', live: [] } });
    ({ root } = await renderAdmin(<Replicas />));
    expect(document.body.textContent).toContain('No replica has checked in');
    await cleanup(root!);
    api.get.mockResolvedValue({ replicas: { role: 'all', live: null } });
    ({ root } = await renderAdmin(<Replicas />));
    expect(document.body.textContent).toContain('only when Redis is configured');
  });

  it('shows nothing for a server too old to report replicas', async () => {
    api.get.mockResolvedValue({ status: 'ok', checks: [] });
    ({ root } = await renderAdmin(<Replicas />));
    expect(document.body.textContent).not.toContain('Replicas');
  });
});
