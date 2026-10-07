// @vitest-environment happy-dom
import type { InstanceSettings, ReadOnlyStatus } from '@oci/shared';
import { QueryClient } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReadOnlyBanner } from '../../src/components/layout/read-only-banner';
import { readOnlyStatus, setReadOnlyStatus } from '../../src/lib/read-only';
import { clearReadOnlyRefusalsWhenLifted } from '../../src/lib/read-only-refusals';
import { AdminInvitesPage } from '../../src/routes/admin/invites';
import { GeneralSettings } from '../../src/routes/admin/settings/general-settings';
import { NameRow } from '../../src/routes/settings/account/name-row';
import { SettingsMemoryPage } from '../../src/routes/settings/memory';
import { button, cleanup, click, renderAdmin, settle } from './admin-test-utils';

/**
 * A change refused while read-only kept its red "Read-only for maintenance
 * until about …" beside the control after read-only was turned off, next to
 * a page whose banner had gone (#308). The real pages, API client, Better
 * Auth client, banner (and its 30 s poll) and a QueryClient set up as
 * main.tsx sets it up run here, against a network that answers as the API's
 * read-only guard does and then as it does once read-only is off.
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

const ON: ReadOnlyStatus = {
  active: true,
  source: 'administrator',
  reason: 'Walk6 resilience check',
  until: new Date(Date.now() + 60 * 60_000).toISOString(),
  window: null,
};
const OFF: ReadOnlyStatus = {
  active: false,
  source: null,
  reason: null,
  until: null,
  window: null,
};

let readOnly: ReadOnlyStatus;
let root: Root | undefined;
let uninstall: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setReadOnlyStatus(OFF);
  // Turned on after the page loaded: its banner has not polled since.
  readOnly = OFF;
  network.handler = async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/maintenance') return Response.json(readOnly);
    if (request.method !== 'GET') {
      if (!readOnly.active) return Response.json({ ok: true });
      return Response.json(
        {
          error: {
            code: 'READ_ONLY',
            message: 'This service is read-only for maintenance.',
            details: { readOnly },
          },
        },
        { status: 423 },
      );
    }
    if (pathname === '/api/memory')
      return Response.json({
        enabled: false,
        available: true,
        entries: [],
        limits: { maxEntries: 200, maxChars: 500 },
      });
    if (pathname === '/api/admin/invites') return Response.json({ invites: [] });
    return new Response(null, { status: 404 });
  };
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  uninstall?.();
  uninstall = undefined;
  document.body.innerHTML = '';
  setReadOnlyStatus(OFF);
  vi.useRealTimers();
});

async function render(page: ReactNode, path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // As main.tsx does.
  uninstall = clearReadOnlyRefusalsWhenLifted(queryClient);
  ({ root } = await renderAdmin(
    <>
      <ReadOnlyBanner />
      {page}
    </>,
    { path, queryClient },
  ));
}

const refusals = () =>
  [...document.querySelectorAll('[role="alert"]')]
    .map((node) => node.textContent?.trim() ?? '')
    .filter((text) => text.includes('Read-only for maintenance'));

/** The administrator turns read-only off; the banner's next poll learns it. */
async function liftReadOnly() {
  readOnly = OFF;
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  await settle();
  expect(document.body.textContent).not.toContain('you can read, search and export');
}

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('clears a refused Settings › Memory switch once read-only is off (a mutation error)', async () => {
  await render(<SettingsMemoryPage />, '/settings/memory');
  readOnly = ON;
  await click(document.getElementById('memory-enabled')!);
  await settle();
  expect(refusals()).toHaveLength(1);

  await liftReadOnly();
  expect(refusals()).toEqual([]);
});

it('clears a refused name change once read-only is off (an error kept by the form)', async () => {
  await render(<NameRow name="Ada" editable />, '/settings/account');
  readOnly = ON;
  await click(button('Edit name'));
  await type(document.querySelector('input')!, 'Ada Lovelace');
  await click(button('Save'));
  expect(refusals()).toHaveLength(1);

  await liftReadOnly();
  expect(refusals()).toEqual([]);
  // The edit is still there to save again.
  expect(document.querySelector('input')?.value).toBe('Ada Lovelace');
});

it('clears a refused admin save once read-only is off (an admin Save row)', async () => {
  const settings = {
    defaultSystemPrompt: null,
    defaultEffort: 'instant',
    maxToolSteps: 8,
    autoCompact: true,
    diagramGuidance: true,
    storage: { driver: 'local' },
    features: { shareLinks: true, temporaryChat: true, branching: true, attachments: true },
  } as unknown as InstanceSettings;
  await render(<GeneralSettings settings={settings} />, '/admin/settings/general');
  readOnly = ON;
  await click(document.getElementById('default-effort')!);
  const high = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (option) => option.textContent === 'High',
  )!;
  await click(high);
  await click(button('Save changes to the default reasoning level'));
  // While read-only, the admin pages hide their Save rows, the refusal with them.
  expect(readOnlyStatus().active).toBe(true);

  // It came back with them, saying read-only when it was not.
  await liftReadOnly();
  expect(button('Save changes to the default reasoning level').disabled).toBe(false);
  expect(refusals()).toEqual([]);
});

it('clears a refused admin dialog save once read-only is off (a form’s problems)', async () => {
  await render(<AdminInvitesPage />, '/admin/invites');
  readOnly = ON;
  await click(button('Create invitation'));
  await type(document.getElementById('invite-email') as HTMLInputElement, 'new@example.test');
  const submit = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (candidate) => candidate.textContent?.trim() === 'Create invitation',
  )!;
  await click(submit);
  expect(refusals()).toHaveLength(1);

  await liftReadOnly();
  expect(refusals()).toEqual([]);
});
