// @vitest-environment happy-dom
import type { UsageAllowance } from '@oci/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  toast: { error: vi.fn(), warning: vi.fn() },
}));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: mocks.data }) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const { UsageLimits } = await import('../../src/components/settings/usage-limits');
const { UsageWarning } = await import('../../src/components/chat/usage-warning');

const NAME = 'Walk AP race policy (users, non-biting)';
const allowance = (overrides: Partial<UsageAllowance>): UsageAllowance => ({
  policyId: 'p1',
  name: NAME,
  metric: 'messages',
  windowKind: 'daily',
  windowHours: null,
  used: 100,
  limitValue: 100,
  remaining: 0,
  exceeded: true,
  resetsAt: null,
  modelSlugs: [],
  severity: 'exceeded',
  ...overrides,
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

async function render(node: React.ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(node));
  return { container, unmount: () => act(() => root.unmount()) };
}

it('never shows people the administrator’s budget name (#93)', async () => {
  mocks.data = {
    allowances: [
      allowance({}),
      allowance({ policyId: 'p2', metric: 'cost', windowKind: 'monthly', modelSlugs: ['m'] }),
    ],
    recent: { messages: 0, tokens: 0 },
  };
  const meter = await render(<UsageLimits />);
  expect(meter.container.textContent).not.toContain(NAME);
  const labels = [...meter.container.querySelectorAll('span[title]')].map((span) => [
    span.textContent,
    span.getAttribute('title'),
  ]);
  expect(labels).toEqual([
    ['Message limit', 'Message limit'],
    ['Usage limit (some models)', 'Usage limit (some models)'],
  ]);
  await meter.unmount();

  const toasts = await render(<UsageWarning />);
  expect(mocks.toast.error).toHaveBeenCalledWith(
    'You have reached your message limit for today.',
    expect.anything(),
  );
  expect(mocks.toast.error).toHaveBeenCalledWith(
    'You have reached your usage limit for this month.',
    expect.objectContaining({ description: 'Other models are still available.' }),
  );
  await toasts.unmount();
});
