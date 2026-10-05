import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The caches wired to cross-replica invalidation (v0.11 design, item 20)
 * besides settings: what another replica's message clears here, that a local
 * change is published, and that a read overlapping an invalidation does not
 * cache what it read (it may predate the change).
 */
const state = vi.hoisted(() => ({
  handlers: new Map<string, (key?: string) => void>(),
  published: [] as Array<{ cache: string; key?: string }>,
  reads: 0,
  /** The next read waits for this, when set. */
  gate: null as Promise<void> | null,
  rows: [] as unknown[],
}));

vi.mock('../../services/cache-bus/index.js', () => ({
  onCacheInvalidation: (cache: string, clear: (key?: string) => void) =>
    state.handlers.set(cache, clear),
  publishInvalidation: async (cache: string, key?: string) => {
    state.published.push({ cache, ...(key === undefined ? {} : { key }) });
  },
}));

/** A query builder whose every step returns itself and which resolves to `state.rows`. */
function query(): unknown {
  const chain: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          state.reads++;
          const gate = state.gate;
          const rows = state.rows;
          return (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
            (gate ?? Promise.resolve()).then(() => resolve(rows), reject);
        }
        return () => chain;
      },
    },
  );
  return chain;
}
vi.mock('../../db/index.js', () => ({ db: { select: () => query(), insert: () => query() } }));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => 'org-1',
}));

const webhooks = await import('../../services/webhooks/endpoints.js');
const connectors = await import('../../services/connectors/tools.js');
const settings = await import('../../services/settings.js');

afterEach(() => {
  state.published.length = 0;
  state.reads = 0;
  state.gate = null;
  state.rows = [];
  webhooks.invalidateWebhookCache();
  connectors.invalidateConnectorCatalog();
  settings.invalidateSettingsCache();
});

describe('settings cache', () => {
  it('is cleared by key or whole by another replica, and publishes each change', async () => {
    state.rows = [{ value: { readOnly: true } }];
    expect(await settings.getSetting('maintenance')).toEqual({ readOnly: true });
    await settings.getSetting('maintenance');
    expect(state.reads).toBe(1);
    state.handlers.get('settings')?.('maintenance');
    await settings.getSetting('maintenance');
    expect(state.reads).toBe(2);
    state.handlers.get('settings')?.();
    await settings.getSetting('maintenance');
    expect(state.reads).toBe(3);

    await settings.updateSetting('maintenance', { readOnly: false });
    expect(state.published).toEqual([{ cache: 'settings', key: 'maintenance' }]);
    await settings.settingsChanged('embeddings');
    expect(state.published.at(-1)).toEqual({ cache: 'settings', key: 'embeddings' });
  });

  it('does not keep a value read while an invalidation arrived', async () => {
    let open = () => {};
    state.gate = new Promise((resolve) => {
      open = resolve;
    });
    state.rows = [{ value: { readOnly: false } }];
    const reading = settings.getSetting('maintenance');
    state.handlers.get('settings')?.('maintenance');
    open();
    expect(await reading).toEqual({ readOnly: false });
    state.gate = null;
    state.rows = [{ value: { readOnly: true } }];
    expect(await settings.getSetting('maintenance')).toEqual({ readOnly: true });
  });
});

describe('webhook endpoints cache', () => {
  it('is cleared by another replica, and publishes its own changes', async () => {
    await webhooks.enabledEndpoints();
    await webhooks.enabledEndpoints();
    expect(state.reads).toBe(1);
    state.handlers.get('webhooks')?.();
    await webhooks.enabledEndpoints();
    expect(state.reads).toBe(2);

    state.published.length = 0;
    webhooks.invalidateWebhookCache();
    expect(state.published).toEqual([{ cache: 'webhooks' }]);
  });

  it('does not keep rows read while an invalidation arrived', async () => {
    let open = () => {};
    state.gate = new Promise((resolve) => {
      open = resolve;
    });
    const reading = webhooks.enabledEndpoints();
    // The change lands on another replica, and its message here, mid-read.
    state.handlers.get('webhooks')?.();
    open();
    await reading;
    state.gate = null;
    await webhooks.enabledEndpoints();
    expect(state.reads).toBe(2);
  });
});

describe('connector catalogue cache', () => {
  it('is cleared by another replica, and publishes its own changes', async () => {
    await connectors.connectorTools();
    await connectors.connectorTools();
    expect(state.reads).toBe(1);
    state.handlers.get('connectors')?.();
    await connectors.connectorTools();
    expect(state.reads).toBe(2);

    state.published.length = 0;
    connectors.invalidateConnectorCatalog();
    expect(state.published).toEqual([{ cache: 'connectors' }]);
  });
});
