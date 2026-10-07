// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareThreadDialog } from '../../src/components/chat/share-thread-dialog';
import { settle } from './admin-test-utils';

/**
 * Where focus starts in the share dialog (#158): the first field, "Share
 * through", or the dialog while that field waits for the messages; never the
 * second field (Expires), which a touch device can open a picker for.
 */
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const MESSAGES = {
  messages: [
    { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Walk3 question' }] },
    { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Walk3 answer' }] },
  ],
};

let root: Root;
let client: QueryClient;
let releaseMessages: () => void;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // The conversation's messages take a moment to arrive, as over a network.
  api.get.mockReset().mockImplementation((path: string) => {
    if (path.startsWith('/share-links/')) return Promise.resolve({ links: [] });
    return new Promise((resolve) => {
      releaseMessages = () => resolve(MESSAGES);
    });
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ShareThreadDialog threadId="t1" />
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

async function open() {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Share conversation"]',
  )!;
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  await settle();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const expires = () => document.getElementById('share-expiration');

describe('the share dialog’s first focus (#158)', () => {
  it('starts on the dialog, not Expires, while Share through waits for the messages', async () => {
    await open();
    expect(document.getElementById('share-cutoff')?.hasAttribute('disabled')).toBe(true);
    expect(document.activeElement).not.toBe(expires());
    expect(document.activeElement).toBe(dialog());
    await act(async () => releaseMessages());
    await settle();
    expect(document.getElementById('share-cutoff')?.hasAttribute('disabled')).toBe(false);
  });

  it('starts on Share through when the messages are already there', async () => {
    client.setQueryData(['thread', 't1', 'share-message-options'], MESSAGES);
    await open();
    expect(document.activeElement).toBe(document.getElementById('share-cutoff'));
  });
});
