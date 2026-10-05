// @vitest-environment happy-dom
import type { ProviderCapacityOverview } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { limitsSummary } from '../../src/components/admin/capacity-limits';
import { ProvidersSection } from '../../src/routes/admin/providers';
import { alerts, button, cleanup, click, dialog, renderAdmin, typeInto } from './admin-test-utils';

/** Provider capacity on the Providers tab (v0.11): limits, queue settings, live state. */
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/providers/theme-provider', () => ({
  useTheme: () => ({ resolvedTheme: 'dark', setColorTheme: vi.fn() }),
}));

const provider = {
  id: 'provider-1',
  label: 'Primary OpenAI',
  kind: 'openai',
  enabled: true,
  baseUrl: null,
  credentialHint: 'abcd',
  modelCount: 1,
};
const none = { requestsPerMinute: null, tokensPerMinute: null, maxConcurrentStreams: null };
const capacity: ProviderCapacityOverview = {
  queue: {
    maxWaitSeconds: 120,
    rolePriority: { admin: 'normal', auditor: 'normal', user: 'normal', restricted: 'normal' },
  },
  enforcement: 'shared',
  providers: [
    {
      providerId: provider.id,
      label: provider.label,
      limits: { ...none, requestsPerMinute: 500, maxConcurrentStreams: 20 },
      queued: 3,
      activeStreams: 20,
      throttledLastHour: 2,
      waitsLastHour: 14,
      longestWaitSeconds: 41,
      coolingUntil: null,
      models: [
        {
          modelId: 'model-1',
          slug: 'gpt',
          displayName: 'GPT Test',
          limits: { ...none, tokensPerMinute: 30_000 },
        },
      ],
    },
  ],
};

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockImplementation(async (path: string) =>
    path === '/admin/providers/capacity' ? capacity : { providers: [provider] },
  );
  api.put.mockResolvedValue({});
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

describe('provider capacity', () => {
  it('shows each provider’s limits and its queue now', async () => {
    ({ root } = await renderAdmin(<ProvidersSection />));
    const table = document.querySelector('table')!;
    expect(table.textContent).toContain('500 requests/min · 20 streams at once');
    expect(table.textContent).toContain('GPT Test: 30,000 tokens/min');
    expect(table.textContent).toContain('14 (longest 41 s)');
    expect(document.body.textContent).not.toContain('each replica enforces');
  });

  it('edits a provider’s limits; empty means no limit', async () => {
    ({ root } = await renderAdmin(<ProvidersSection />));
    await click(button('Capacity limits for Primary OpenAI'));
    const form = dialog()!;
    const input = (id: string) => form.querySelector<HTMLInputElement>(`#capacity-${id}`)!;
    expect(input('requestsPerMinute').value).toBe('500');
    await typeInto(input('requestsPerMinute'), '');
    await typeInto(input('tokensPerMinute'), '90,000');
    await typeInto(input('maxConcurrentStreams'), '0');
    await click(button('Save limits'));
    expect(alerts(form)).toEqual([
      'Replies at once must be a whole number of at least 1, or empty for no limit.',
    ]);
    await typeInto(input('maxConcurrentStreams'), '8');
    await click(button('Save limits'));
    expect(api.put).toHaveBeenCalledWith('/admin/providers/provider-1/capacity', {
      requestsPerMinute: null,
      tokensPerMinute: 90_000,
      maxConcurrentStreams: 8,
    });
  });

  it('saves the longest wait and role priority', async () => {
    ({ root } = await renderAdmin(<ProvidersSection />));
    await typeInto(document.querySelector<HTMLInputElement>('#capacity-max-wait')!, '2');
    await click(button('Save changes'));
    expect(alerts()).toContain('The longest wait must be between 5 and 1,800 seconds.');
    await typeInto(document.querySelector<HTMLInputElement>('#capacity-max-wait')!, '300');
    await click(button('Save changes'));
    expect(api.put).toHaveBeenCalledWith('/admin/providers/capacity', {
      maxWaitSeconds: 300,
      rolePriority: capacity.queue.rolePriority,
    });
  });

  it('says when limits hold per replica only', async () => {
    api.get.mockImplementation(async (path: string) =>
      path === '/admin/providers/capacity'
        ? { ...capacity, enforcement: 'local' }
        : { providers: [provider] },
    );
    ({ root } = await renderAdmin(<ProvidersSection />));
    expect(document.body.textContent).toContain('each replica enforces the limits on its own');
  });

  it('summarises limits', () => {
    expect(limitsSummary(undefined)).toBe('No limits');
    expect(limitsSummary(none)).toBe('No limits');
    expect(limitsSummary({ ...none, maxConcurrentStreams: 1 })).toBe('1 stream at once');
  });
});
