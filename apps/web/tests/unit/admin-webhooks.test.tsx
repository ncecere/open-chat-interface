// @vitest-environment happy-dom
import type { WebhookEndpoint } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminWebhooksPage,
  parseActions,
  unmatchedActions,
  webhookChanges,
} from '../../src/routes/admin/webhooks';
import {
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  typeInto,
} from './admin-test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function endpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: 'w1',
    url: 'https://hooks.example.test/oci',
    description: 'SIEM',
    actions: ['backup.run', 'user.*'],
    allActions: false,
    enabled: true,
    allowPrivateNetwork: false,
    secretRotatedAt: '2026-10-01T09:00:00.000Z',
    lastSuccessAt: '2026-10-01T10:00:00.000Z',
    lastFailureAt: '2026-10-01T11:00:00.000Z',
    lastError: 'The endpoint answered HTTP 500.',
    pendingDeliveries: 2,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

let root: Root | undefined;
let webhooks: WebhookEndpoint[];
beforeEach(() => {
  webhooks = [endpoint()];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/webhooks') return { webhooks };
    if (path === '/admin/audit/actions') return { actions: ['user.create', 'backup.run'] };
    if (path === '/admin/webhooks/w1/deliveries')
      return {
        deliveries: [
          {
            id: 'd1',
            event: 'user.create',
            status: 'pending',
            attempts: 2,
            maxAttempts: 8,
            nextAttemptAt: '2026-10-01T11:04:00.000Z',
            lastAttemptAt: '2026-10-01T11:00:00.000Z',
            lastStatusCode: 500,
            lastError: 'The endpoint answered HTTP 500.',
            deliveredAt: null,
            createdAt: '2026-10-01T10:59:00.000Z',
          },
        ],
      };
    throw new Error(`Unexpected GET ${path}`);
  });
  api.post.mockReset();
  api.patch.mockReset().mockResolvedValue(endpoint());
  api.delete.mockReset().mockResolvedValue({ ok: true });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (role: 'admin' | 'auditor' = 'admin') => {
  ({ root } = await renderAdmin(<AdminWebhooksPage />, { role, path: '/admin/webhooks' }));
};

describe('Webhooks admin page', () => {
  it('lists endpoints with their actions, failures and pending deliveries', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('SIEM');
    expect(text).toContain('https://hooks.example.test/oci');
    expect(text).toContain('backup.run, user.*');
    expect(text).toContain('2 pending');
    expect(text).toContain('The endpoint answered HTTP 500.');
    expect(text).toContain('OCI-Webhook-Signature');
  });

  it('adds an endpoint and shows its secret once', async () => {
    webhooks = [];
    await render();
    expect(document.body.textContent).toContain('No webhook endpoints yet.');
    await click(button('Add endpoint'));
    await typeInto(
      document.getElementById('webhook-url') as HTMLInputElement,
      'https://new.example.test/h',
    );
    const actions = document.getElementById('webhook-actions') as HTMLTextAreaElement;
    await act(actions, 'user.*\nbackup.run, user.*\n');
    api.post.mockResolvedValueOnce({ ...endpoint({ id: 'w2' }), secret: 'whsec_shown_once' });
    const submit = [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Add endpoint',
    )!;
    await click(submit);
    expect(api.post).toHaveBeenCalledWith('/admin/webhooks', {
      url: 'https://new.example.test/h',
      description: '',
      allActions: false,
      actions: ['user.*', 'backup.run'],
      enabled: true,
      allowPrivateNetwork: false,
    });
    const shown = document.querySelector<HTMLInputElement>('input[aria-label="Signing secret"]');
    expect(shown?.value).toBe('whsec_shown_once');
    await click(button('Copy secret'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('whsec_shown_once');
    await click(button('Done'));
    expect(document.querySelector('input[aria-label="Signing secret"]')).toBeNull();
  });

  it('warns about an action nothing recorded matches, and still saves it (#83)', async () => {
    expect(
      unmatchedActions(
        ['user.*', 'backup.run', 'walk.nonexistent.action', 'walk.*'],
        ['user.create', 'backup.run'],
      ),
    ).toEqual(['walk.nonexistent.action', 'walk.*']);

    webhooks = [];
    await render();
    await click(button('Add endpoint'));
    const actions = document.getElementById('webhook-actions') as HTMLTextAreaElement;
    await act(actions, 'user.*\nwalk.nonexistent.action');
    const warning = document.getElementById(actions.getAttribute('aria-describedby') ?? '');
    expect(warning?.textContent).toContain(
      'Nothing recorded so far matches walk.nonexistent.action.',
    );
    await act(actions, 'user.*');
    expect(actions.getAttribute('aria-describedby')).toBeNull();
  });

  it('sends a test, rotates the secret after confirming, and shows the delivery log', async () => {
    await render();
    api.post.mockResolvedValueOnce({ ok: true, status: 204, error: null });
    await click(button('Send test'));
    expect(api.post).toHaveBeenCalledWith('/admin/webhooks/w1/test');
    expect(document.body.textContent).toContain('Test delivered (HTTP 204).');

    await click(button('Rotate secret'));
    expect(dialog()?.textContent).toContain('signed with the new secret');
    api.post.mockResolvedValueOnce({ ...endpoint(), secret: 'whsec_rotated' });
    const confirm = [...dialog()!.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Rotate secret',
    )!;
    await click(confirm);
    expect(api.post).toHaveBeenCalledWith('/admin/webhooks/w1/rotate');
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Signing secret"]')?.value,
    ).toBe('whsec_rotated');
    await click(button('Done'));

    await click(button('Show deliveries'));
    const log = document.querySelector('table')!;
    expect(log.textContent).toContain('user.create');
    expect(log.textContent).toContain('retrying');
    expect(log.textContent).toContain('2 of 8');
    // It scrolls sideways on phones, so keyboard users can focus and scroll it.
    const region = log.parentElement!;
    // A labelled <section> is a region landmark.
    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('aria-label')).toBe(
      'Recent deliveries to https://hooks.example.test/oci',
    );
  });

  it('confirms before deleting', async () => {
    await render();
    await click(button('Delete https://hooks.example.test/oci'));
    expect(dialog()?.textContent).toContain('2 pending deliveries');
    await click(button('Delete endpoint'));
    expect(api.delete).toHaveBeenCalledWith('/admin/webhooks/w1');
  });

  it('is read-only for auditors, who can still read the delivery log', async () => {
    await render('auditor');
    for (const name of [
      'Add endpoint',
      'Send test',
      'Rotate secret',
      'Delete https://hooks.example.test/oci',
    ])
      expect(findButton(name), name).toBeUndefined();
    await click(button('Show deliveries'));
    expect(document.querySelector('table')?.textContent).toContain('user.create');
  });
});

describe('webhook form helpers', () => {
  it('parses actions and sends only changed fields', () => {
    expect(parseActions(' user.* ,\n\nbackup.run\nuser.*')).toEqual(['user.*', 'backup.run']);
    const saved = endpoint();
    const draft = {
      url: saved.url,
      description: 'SIEM',
      allActions: false,
      actions: 'user.*\nbackup.run',
      enabled: true,
      allowPrivateNetwork: false,
    };
    expect(webhookChanges(saved, draft)).toEqual({});
    expect(webhookChanges(saved, { ...draft, actions: 'user.*', enabled: false })).toEqual({
      actions: ['user.*'],
      enabled: false,
    });
  });
});

/** Sets a textarea's value the way React observes typing. */
async function act(element: HTMLTextAreaElement, value: string) {
  const { act: reactAct } = await import('react');
  await reactAct(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
