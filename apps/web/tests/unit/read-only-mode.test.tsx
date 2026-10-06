// @vitest-environment happy-dom
import type { CatalogModel, MaintenanceSettings, ReadOnlyStatus } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveRow } from '../../src/components/admin/admin-ui';
import { MaintenanceMode } from '../../src/components/admin/maintenance-mode';
import { Composer } from '../../src/components/chat/composer';
import { MessageActions } from '../../src/components/chat/message-actions';
import { ReadOnlyBanner } from '../../src/components/layout/read-only-banner';
import { chatErrorText } from '../../src/lib/api-client';
import { fetchRetryingDrain } from '../../src/lib/chat-retry';
import {
  formatReadOnlyTime,
  noteReadOnlyRefusal,
  readOnlyMessage,
  readOnlyStatus,
  setReadOnlyStatus,
} from '../../src/lib/read-only';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { button, cleanup, click, renderAdmin, settle, typeInto } from './admin-test-utils';

/**
 * Read-only maintenance mode in the web app (v0.11 design, section 9): the
 * banner says why and until when, the composer, uploads, edits and admin
 * saves are off, the switch itself stays usable, and a write that raced the
 * switch is explained rather than shown as a failure.
 */
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
vi.mock('../../src/components/chat/composer-connect-hint', () => ({
  ComposerConnectHint: () => null,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

const OFF: ReadOnlyStatus = {
  active: false,
  source: null,
  reason: null,
  until: null,
  window: null,
};
const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
const ON: ReadOnlyStatus = {
  active: true,
  source: 'administrator',
  reason: 'Upgrading the database',
  until,
  window: null,
};

const model: CatalogModel = {
  id: 'm',
  slug: 'm',
  displayName: 'Model',
  description: null,
  providerId: 'p',
  providerKind: 'openai-compatible',
  providerLabel: 'P',
  upstreamModelId: 'm',
  capabilities: [],
  labId: 'openai',
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
};

let container: HTMLDivElement;
let root: Root;
let adminRoot: Root | null = null;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  setReadOnlyStatus(OFF);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  if (adminRoot) await cleanup(adminRoot);
  adminRoot = null;
  vi.clearAllMocks();
});

async function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    value: 'Hello',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    models: [model],
    selectedModel: model,
    onSelectModel: vi.fn(),
    effort: 'instant',
    onEffortChange: vi.fn(),
    webSearch: false,
    onWebSearchChange: vi.fn(),
    onAttachFiles: vi.fn(),
    ...overrides,
  };
  await act(() =>
    root.render(
      <ThemeProvider>
        <Composer {...props} />
      </ThemeProvider>,
    ),
  );
  return props;
}

const sendButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
const textarea = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message input"]')!;

describe('composer', () => {
  it('sends normally when the instance is not read-only', async () => {
    await renderComposer();
    expect(sendButton().disabled).toBe(false);
    expect(textarea().disabled).toBe(false);
  });

  it('is disabled with the reason while read-only, and comes back when it ends', async () => {
    const props = await renderComposer();
    await act(async () => setReadOnlyStatus(ON));
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().title).toMatch(/^Read-only for maintenance until about /);
    expect(textarea().disabled).toBe(true);
    expect(textarea().placeholder).toMatch(/^Read-only for maintenance until about /);
    // Enter does nothing either.
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(props.onSubmit).not.toHaveBeenCalled();
    // Uploading is off with it, and says why.
    const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach"]');
    expect(attach?.disabled).toBe(true);
    expect(attach?.title).toMatch(/^Read-only for maintenance/);

    await act(async () => setReadOnlyStatus(OFF));
    expect(sendButton().disabled).toBe(false);
    expect(textarea().disabled).toBe(false);
  });
});

describe('message actions', () => {
  it('turns editing, retrying and forking off while read-only', async () => {
    const onEdit = vi.fn();
    const render = () =>
      act(() =>
        root.render(
          <QueryClientProvider client={new QueryClient()}>
            <MessageActions text="Hi" onEdit={onEdit} onRetry={vi.fn()} onFork={async () => {}} />
          </QueryClientProvider>,
        ),
      );
    setReadOnlyStatus(ON);
    await render();
    for (const label of ['Edit message', 'Retry', 'Fork conversation']) {
      const control = container.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!;
      expect(control.disabled, label).toBe(true);
      expect(control.title).toContain('Read-only for maintenance');
    }
    // Copying is reading.
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label^="Copy message"]')!.disabled,
    ).toBe(false);
  });
});

describe('banner', () => {
  async function renderBanner() {
    await act(() => root.render(<ReadOnlyBanner />));
    await settle();
  }

  it('shows nothing when changes are allowed', async () => {
    api.get.mockResolvedValue(OFF);
    await renderBanner();
    expect(api.get).toHaveBeenCalledWith('/maintenance');
    expect(container.textContent).toBe('');
  });

  it('ignores an answer that is not a status, and a failed request', async () => {
    api.get.mockResolvedValueOnce({ unexpected: true });
    await renderBanner();
    expect(readOnlyStatus()).toEqual(OFF);
    api.get.mockRejectedValueOnce(new Error('offline'));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(readOnlyStatus()).toEqual(OFF);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('explains why and until when, and shares the state with the composer', async () => {
    api.get.mockResolvedValue(ON);
    await renderBanner();
    const banner = container.querySelector('[role="status"]');
    expect(banner?.textContent).toContain('Read-only for maintenance until about');
    expect(banner?.textContent).toContain(
      'you can read, search and export, but changes can’t be saved. Upgrading the database.',
    );
    expect(readOnlyStatus()).toEqual(ON);
  });
});

describe('a write that races the switch', () => {
  const refusal = {
    error: { code: 'READ_ONLY', message: 'server words', details: { readOnly: ON } },
  };

  it('turns a refused chat turn into the read-only explanation', () => {
    expect(chatErrorText(new Error(JSON.stringify(refusal)))).toBe(readOnlyMessage(ON));
    expect(
      chatErrorText(new Error(JSON.stringify({ error: { code: 'READ_ONLY', message: 'x' } }))),
    ).toBe(
      'Read-only for maintenance: you can read, search and export, but changes can’t be saved.',
    );
  });

  it('switches the page to read-only from the refusal itself', async () => {
    const send = vi.fn(
      async () =>
        new Response(JSON.stringify(refusal), {
          status: 423,
          headers: { 'content-type': 'application/json', 'retry-after': '7200' },
        }),
    );
    const response = await fetchRetryingDrain(send, '/api/chat', { method: 'POST', body: '{}' });
    // Not retried: read-only is not a drain.
    expect(send).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(423);
    // The caller still gets the whole body.
    expect(await response.json()).toEqual(refusal);
    expect(readOnlyStatus()).toEqual(ON);
  });

  it('notes refusals without details as read-only too, and ignores other errors', () => {
    expect(noteReadOnlyRefusal({ error: { code: 'CONFLICT' } })).toBe(false);
    expect(readOnlyStatus().active).toBe(false);
    expect(noteReadOnlyRefusal({ error: { code: 'READ_ONLY' } })).toBe(true);
    expect(readOnlyStatus().active).toBe(true);
  });

  it('says what the API client shows for a refused save', async () => {
    const { ApiError } = await import('../../src/lib/api-client');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(refusal), { status: 423 }));
    vi.stubGlobal('fetch', fetchMock);
    const actual = await vi.importActual<typeof import('../../src/lib/api-client')>(
      '../../src/lib/api-client',
    );
    const error = await actual.api.patch('/me/preferences', {}).catch((caught: unknown) => caught);
    vi.unstubAllGlobals();
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 423, code: 'READ_ONLY', message: readOnlyMessage(ON) });
    expect(readOnlyStatus()).toEqual(ON);
  });
});

describe('administration', () => {
  const view = (overrides: Partial<MaintenanceSettings> = {}): MaintenanceSettings => ({
    status: OFF,
    environmentLocked: false,
    readOnly: false,
    reason: null,
    until: null,
    changedAt: null,
    changedBy: null,
    window: null,
    jobs: [
      { name: 'backups.run', keepsRunning: true, defaultKeepsRunning: true },
      { name: 'imports.process', keepsRunning: false, defaultKeepsRunning: false },
    ],
    ...overrides,
  });

  it('turns read-only on after a confirmation, with the reason', async () => {
    api.get.mockResolvedValue(view());
    api.put.mockResolvedValue(view({ readOnly: true, status: ON, reason: ON.reason }));
    adminRoot = (await renderAdmin(<MaintenanceMode />)).root;
    await click(button('Turn on read-only mode'));
    expect(api.put).not.toHaveBeenCalled();
    await click(button('Confirm: refuse every change now'));
    expect(api.put).toHaveBeenCalledWith('/admin/maintenance', {
      readOnly: true,
      reason: null,
      until: null,
    });
    // This tab follows at once.
    expect(readOnlyStatus()).toEqual(ON);
  });

  it('keeps the switch usable while every other save is off', async () => {
    setReadOnlyStatus(ON);
    api.get.mockResolvedValue(view({ readOnly: true, status: ON }));
    api.put.mockResolvedValue(view());
    adminRoot = (
      await renderAdmin(
        <>
          <MaintenanceMode />
          <SaveRow hasChanges isPending={false} errorMessage={null} successMessage={null} />
        </>,
      )
    ).root;
    // A settings form's Save is gone while read-only...
    expect(
      [...document.querySelectorAll('button')].some((b) => b.textContent === 'Save changes'),
    ).toBe(false);
    // ...but the way back is not.
    await click(button('Turn off read-only mode'));
    expect(api.put).toHaveBeenCalledWith('/admin/maintenance', { readOnly: false });
    expect(readOnlyStatus().active).toBe(false);
  });

  it('shows auditors the state without the controls, and says when the environment holds it', async () => {
    api.get.mockResolvedValue(
      view({
        environmentLocked: true,
        status: { ...ON, source: 'environment', until: null },
      }),
    );
    const rendered = await renderAdmin(<MaintenanceMode />, { role: 'auditor' });
    adminRoot = rendered.root;
    const page = rendered.container;
    expect(page.textContent).toContain('Read-only, by the OCI_READ_ONLY environment variable');
    expect(page.textContent).toContain('Unset it on every replica');
    expect(
      [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes('read-only')),
    ).toEqual([]);
    expect(
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
        (box) => box.disabled,
      ),
    ).toBe(true);
  });

  it('says why a window cannot be scheduled yet, beside the button (#81)', async () => {
    api.get.mockResolvedValue(view());
    adminRoot = (await renderAdmin(<MaintenanceMode />)).root;
    const schedule = button('Schedule window');
    const reason = () =>
      document.getElementById(schedule.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(schedule.disabled).toBe(true);
    expect(reason()).toBe('Choose when the window starts and ends.');

    // The window's own fields (the switch above has an Until field too).
    const starts = document.querySelector<HTMLInputElement>('input[id$="-start"]');
    const ends = document.querySelector<HTMLInputElement>('input[id$="-end"]');
    const set = typeInto;
    await set(starts!, '2027-01-10T10:00');
    await set(ends!, '2027-01-10T09:00');
    expect(reason()).toBe('The end must be after the start.');
    await set(ends!, '2027-01-10T12:00');
    expect(schedule.disabled).toBe(false);
    expect(schedule.getAttribute('aria-describedby')).toBeNull();
  });

  it('names the year of a window in another year (#81)', () => {
    const now = new Date('2026-10-05T12:00:00');
    expect(formatReadOnlyTime('2027-01-10T10:00:00', now)).toContain('2027');
    expect(formatReadOnlyTime('2026-10-11T10:00:00', now)).not.toContain('2026');
  });

  it('chooses the jobs that keep running', async () => {
    api.get.mockResolvedValue(view());
    api.put.mockResolvedValue(view());
    adminRoot = (await renderAdmin(<MaintenanceMode />)).root;
    const imports = [...document.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('imports.process'),
    )!;
    await click(imports.querySelector('input')!);
    await click(button('Save jobs'));
    expect(api.put).toHaveBeenCalledWith('/admin/maintenance', {
      keepRunningJobs: ['backups.run', 'imports.process'],
    });
  });
});
