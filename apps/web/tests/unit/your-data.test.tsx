// @vitest-environment happy-dom
import type { ConversationImportSummary } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  del: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('../../src/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/api-client')>();
  return { ...actual, api: { get: mocks.get, delete: mocks.del } };
});
vi.mock('../../src/lib/import-upload', () => ({ uploadImportFile: mocks.upload }));

const { ApiError } = await import('../../src/lib/api-client');
const { IMPORT_POLL_MS, YourDataSection } = await import('../../src/components/settings/your-data');

function record(overrides: Partial<ConversationImportSummary> = {}): ConversationImportSummary {
  return {
    id: 'import-1',
    source: 'chatgpt',
    status: 'completed',
    filename: 'chatgpt-export.zip',
    sizeBytes: 2 * 1024 * 1024,
    importedCount: 12,
    skippedCount: 3,
    failedCount: 1,
    error: null,
    formatVersion: 'v2',
    warnings: [],
    unknownContentTypes: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <YourDataSection />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

function fileInput(): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

async function choose(file: File) {
  const input = fileInput();
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.get.mockReset();
  mocks.del.mockReset();
  mocks.upload.mockReset();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it('offers a full export download and a labelled import picker', async () => {
  mocks.get.mockResolvedValue({ imports: [] });
  await render();

  const link = [...container.querySelectorAll('a')].find((anchor) =>
    anchor.textContent?.includes('Export all conversations'),
  );
  expect(link?.getAttribute('href')).toBe('/api/me/export');
  expect(link?.hasAttribute('download')).toBe(true);

  const input = fileInput();
  const label = container.querySelector(`label[for="${input.id}"]`);
  expect(label?.textContent).toBe('Import from ChatGPT or Claude');
  expect(input.getAttribute('accept')).toContain('.zip');
  expect(input.getAttribute('aria-describedby')).toBeTruthy();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

it('lists imports with their status and counts, and removes a finished one', async () => {
  mocks.get.mockResolvedValue({
    imports: [
      record(),
      record({
        id: 'import-2',
        status: 'failed',
        source: 'unknown',
        filename: 'notes.txt',
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        formatVersion: null,
        error: 'No ChatGPT or Claude conversations were found in this file.',
      }),
    ],
  });
  mocks.del.mockResolvedValue({ ok: true });
  await render();

  const items = container.querySelectorAll('ul[aria-label="Imports"] li');
  expect(items).toHaveLength(2);
  expect(items[0]?.textContent).toContain('Completed');
  expect(items[0]?.textContent).toContain('ChatGPT (v2 export)');
  expect(items[0]?.textContent).toContain('12 imported · 3 skipped · 1 failed');
  expect(items[1]?.textContent).toContain('Failed');
  expect(items[1]?.textContent).toContain('No ChatGPT or Claude conversations');

  const remove = container.querySelector(
    'button[aria-label="Remove chatgpt-export.zip"]',
  ) as HTMLButtonElement;
  await act(async () => remove.click());
  await settle();
  expect(mocks.del).toHaveBeenCalledWith('/me/imports/import-1');
});

it('uploads with visible progress and announces the result', async () => {
  mocks.get.mockResolvedValue({ imports: [] });
  let report!: (fraction: number) => void;
  let finish!: (value: ConversationImportSummary) => void;
  mocks.upload.mockImplementation(
    (_file: File, onProgress: (fraction: number) => void) =>
      new Promise((resolve) => {
        report = onProgress;
        finish = resolve;
      }),
  );
  await render();

  await choose(new File(['{}'], 'conversations.json', { type: 'application/json' }));
  expect(mocks.upload).toHaveBeenCalledOnce();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'Uploading conversations.json',
  );

  await act(async () => report(0.42));
  const progress = container.querySelector('progress') as HTMLProgressElement;
  expect(progress.getAttribute('aria-label')).toBe('Upload progress');
  expect(progress.value).toBe(42);
  expect(container.textContent).toContain('42%');
  expect(fileInput().disabled).toBe(true);

  mocks.get.mockResolvedValue({
    imports: [record({ status: 'pending', filename: 'conversations.json', importedCount: 0 })],
  });
  await act(async () => finish(record({ status: 'pending', filename: 'conversations.json' })));
  await settle();

  expect(container.querySelector('progress')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'conversations.json uploaded',
  );
  expect(container.querySelector('ul[aria-label="Imports"]')?.textContent).toContain('Queued');
  // A queued import cannot be joined by another upload.
  expect(fileInput().disabled).toBe(true);
});

it('shows the server’s reason when an upload is refused', async () => {
  mocks.get.mockResolvedValue({ imports: [] });
  mocks.upload.mockRejectedValue(
    new ApiError(413, 'VALIDATION_FAILED', 'The file is larger than the 512 MB import limit.'),
  );
  await render();

  await choose(new File(['x'], 'huge.zip'));
  await settle();

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'The file is larger than the 512 MB import limit.',
  );
  expect(fileInput().disabled).toBe(false);
});

it('polls while an import runs and announces when it finishes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.get.mockResolvedValueOnce({
    imports: [record({ status: 'running', importedCount: 4, skippedCount: 0, failedCount: 0 })],
  });
  await render();

  const running = container.querySelector('ul[aria-label="Imports"] li');
  expect(running?.textContent).toContain('Importing');
  const cancel = container.querySelector(
    'button[aria-label="Cancel import of chatgpt-export.zip"]',
  ) as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);

  mocks.get.mockResolvedValue({ imports: [record({ skippedCount: 0, failedCount: 0 })] });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS + 100);
  });
  await settle();

  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Import of chatgpt-export.zip finished: 12 conversations imported.',
  );

  // Nothing active: polling stops.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(IMPORT_POLL_MS * 3);
  });
  expect(mocks.get).toHaveBeenCalledTimes(2);
});
