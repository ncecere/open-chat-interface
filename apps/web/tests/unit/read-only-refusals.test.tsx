// @vitest-environment happy-dom
import type { ReadOnlyStatus, ThreadSummary } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadList } from '../../src/components/layout/thread-list';
import { readOnlyStatus, setReadOnlyStatus } from '../../src/lib/read-only';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { NameRow } from '../../src/routes/settings/account/name-row';
import { SettingsCustomizationPage } from '../../src/routes/settings/customization';
import { button, cleanup, click, renderAdmin, settle } from './admin-test-utils';

/**
 * Changes refused by read-only maintenance (#159), through the real API
 * client, Better Auth client, query cache and toasts, against a network that
 * answers as the API's read-only guard does. Settings saves said "could not
 * be saved. Try again." and the sidebar's Pin and Archive failed silently.
 */
const network = vi.hoisted(() => {
  const state = {
    handler: (async () => new Response(null, { status: 404 })) as (
      request: Request,
    ) => Promise<Response>,
  };
  // Installed before the auth client is created, which keeps the fetch it finds.
  globalThis.fetch = (input, init) =>
    state.handler(
      new Request(
        new URL(String(input instanceof Request ? input.url : input), 'http://localhost:3000'),
        init,
      ),
    );
  return state;
});

const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const ON: ReadOnlyStatus = {
  active: true,
  source: 'administrator',
  reason: 'Walk3 resilience read-only test',
  until,
  window: null,
};
const OFF: ReadOnlyStatus = {
  active: false,
  source: null,
  reason: null,
  until: null,
  window: null,
};

/** The read-only guard's answer (apps/api/src/middleware/read-only.ts). */
const refused = () =>
  Response.json(
    {
      error: {
        code: 'READ_ONLY',
        message: 'This service is read-only for maintenance.',
        details: { readOnly: ON },
      },
    },
    { status: 423 },
  );

const thread: ThreadSummary = {
  id: 't1',
  title: 'Trip plans',
  pinned: false,
  archived: false,
  projectId: null,
  parentThreadId: null,
  temporary: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastMessageAt: new Date().toISOString(),
} as unknown as ThreadSummary;

const writes: string[] = [];
beforeEach(() => {
  writes.length = 0;
  setReadOnlyStatus(OFF);
  localStorage.clear();
  network.handler = async (request) => {
    const { pathname, search } = new URL(request.url);
    if (request.method !== 'GET') {
      writes.push(`${request.method} ${pathname}`);
      return refused();
    }
    if (pathname === '/api/me')
      return Response.json({
        user: { id: 'u1', name: 'Ada', email: 'ada@example.test', role: 'user' },
        preferences: { displayName: 'Ada', occupation: null, traits: [], additionalContext: null },
        features: { projects: false },
        signIn: { password: true, credential: true, sso: [] },
      });
    if (pathname === '/api/threads' && search === '?view=sidebar')
      return Response.json({ threads: [thread] });
    return new Response(null, { status: 404 });
  };
});
let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  document.body.innerHTML = '';
  setReadOnlyStatus(OFF);
});

const reason =
  /^Read-only for maintenance until about .+: you can read, search and export, but changes can’t be saved\. Walk3 resilience read-only test\.$/;

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const alerts = () =>
  [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent?.trim());

describe('read-only refusals in Settings', () => {
  it('gives the reason when the name is refused, not "Try again"', async () => {
    ({ root } = await renderAdmin(<NameRow name="Ada" editable />));
    await click(button('Edit name'));
    await type(document.querySelector('input')!, 'Ada Lovelace');
    await click(button('Save'));
    expect(writes).toEqual(['POST /api/auth/update-user']);
    expect(alerts()).toEqual([expect.stringMatching(reason)]);
    // The rest of the page follows: the banner and the other controls.
    expect(readOnlyStatus().active).toBe(true);
  });

  it('gives the reason when preferences are refused', async () => {
    ({ root } = await renderAdmin(
      <ThemeProvider>
        <SettingsCustomizationPage />
      </ThemeProvider>,
      { path: '/settings/customization' },
    ));
    await type(document.querySelector<HTMLInputElement>('#occupation')!, 'Librarian');
    await click(button('Save Preferences'));
    expect(writes).toEqual(['PATCH /api/me/preferences']);
    expect(alerts()).toEqual([expect.stringMatching(reason)]);
  });
});

describe('read-only refusals in the sidebar', () => {
  async function renderSidebar() {
    ({ root } = await renderAdmin(
      <>
        <ThreadList />
        <Toaster />
      </>,
    ));
  }

  it('says why Pin was refused instead of failing silently', async () => {
    await renderSidebar();
    await click(button('Pin conversation: Trip plans'));
    await settle();
    expect(writes).toEqual(['PATCH /api/threads/t1']);
    const toast = document.querySelector('[data-sonner-toast]');
    expect(toast?.textContent).toContain('The conversation could not be pinned');
    expect(toast?.textContent).toMatch(/Read-only for maintenance until about .+Walk3 resilience/);
  });

  it('says why Archive was refused', async () => {
    await renderSidebar();
    await click(button('Archive conversation: Trip plans'));
    await settle();
    expect(document.querySelector('[data-sonner-toast]')?.textContent).toContain(
      'The conversation could not be archived',
    );
    // Still listed: nothing was archived.
    expect(document.body.textContent).toContain('Trip plans');
  });

  it('turns Pin, Rename and Archive off while read-only, with the reason', async () => {
    setReadOnlyStatus(ON);
    await renderSidebar();
    for (const name of [
      'Pin conversation: Trip plans',
      'Rename conversation: Trip plans',
      'Archive conversation: Trip plans',
    ]) {
      expect(button(name).disabled).toBe(true);
      expect(button(name).title).toMatch(/^Read-only for maintenance until about /);
    }
  });
});
