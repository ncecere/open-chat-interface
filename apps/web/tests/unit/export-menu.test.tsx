// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportFormatsFor } from '../../src/components/chat/export-menu';
import { MessageActions } from '../../src/components/chat/message-actions';
import { ApiError, dispositionFilename } from '../../src/lib/api-client';
import { alerts, button, cleanup, click, findButton, settle } from './admin-test-utils';

/** "Export as…" on replies (v0.9 file output). */

const api = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

const TABLE_REPLY = 'Totals:\n\n| Region | Sales |\n| --- | ---: |\n| North | 12 |';
const target = { threadId: 'thread 1', messageId: 'reply-1' };

let root: Root | undefined;
let saved: { href: string; download: string }[] = [];

beforeEach(() => {
  api.download.mockReset();
  saved = [];
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:export'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.href, download: this.download });
  });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.restoreAllMocks();
});

async function mount(text: string, exportTarget: typeof target | null = target) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<MessageActions text={text} exportTarget={exportTarget ?? undefined} />),
  );
  await settle();
  return container;
}

const trigger = () => button('Export as…');
const items = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
    entry.textContent?.startsWith(label),
  )!;

async function key(element: Element | null, name: string) {
  await act(async () => {
    element?.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

async function openWithKeyboard() {
  trigger().focus();
  await key(trigger(), 'Enter');
}

describe('the export menu on a reply', () => {
  it('is a menu button offering DOCX, PDF and PPTX, and XLSX only with a table', async () => {
    await mount('Just a paragraph.');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await openWithKeyboard();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(items()).toEqual(['Word document (.docx)', 'PDF (.pdf)', 'Presentation (.pptx)']);

    await cleanup(root!);
    root = undefined;
    await mount(TABLE_REPLY);
    await openWithKeyboard();
    expect(items()).toEqual([
      'Word document (.docx)',
      'PDF (.pdf)',
      'Presentation (.pptx)',
      'Spreadsheet (.xlsx)',
    ]);
  });

  it('downloads the chosen format under the name the API gives', async () => {
    api.download.mockResolvedValue({
      blob: new Blob(['PK']),
      filename: 'quarterly-plan-reply-2026-10-02.docx',
    });
    await mount(TABLE_REPLY);
    await openWithKeyboard();
    await click(item('Word document'));
    expect(api.download).toHaveBeenCalledWith(
      '/threads/thread%201/messages/reply-1/export?format=docx',
    );
    expect(saved).toEqual([
      { href: 'blob:export', download: 'quarterly-plan-reply-2026-10-02.docx' },
    ]);
    expect(alerts()).toEqual([]);
    // The menu closed and focus is back on its button.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('falls back to a generic name when the response has none', async () => {
    api.download.mockResolvedValue({ blob: new Blob(['%PDF']), filename: null });
    await mount('Text');
    await openWithKeyboard();
    await click(item('PDF'));
    expect(api.download).toHaveBeenCalledWith(
      '/threads/thread%201/messages/reply-1/export?format=pdf',
    );
    expect(saved.map((entry) => entry.download)).toEqual(['reply.pdf']);
  });

  it('shows the API’s message inline when the export is refused, until dismissed', async () => {
    api.download.mockRejectedValue(
      new ApiError(429, 'RATE_LIMITED', 'Too many downloads in the last hour. Try again later.'),
    );
    await mount(TABLE_REPLY);
    await openWithKeyboard();
    await click(item('Spreadsheet'));
    expect(alerts()).toEqual(['Too many downloads in the last hour. Try again later.Dismiss']);
    expect(saved).toEqual([]);
    await click(button('Dismiss'));
    expect(alerts()).toEqual([]);

    // A network failure has its own, readable text.
    api.download.mockRejectedValue(new TypeError('Failed to fetch'));
    await openWithKeyboard();
    await click(item('Presentation'));
    expect(alerts()[0]).toContain('The PPTX file could not be downloaded.');
  });

  it('can be used with the keyboard alone and returns focus on Escape', async () => {
    api.download.mockResolvedValue({ blob: new Blob(['PK']), filename: 'a.pptx' });
    await mount('Text');
    trigger().focus();
    await key(trigger(), 'ArrowDown');
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
    await key(document.activeElement, 'Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());

    await key(trigger(), 'ArrowDown');
    await key(document.activeElement, 'ArrowDown');
    await key(document.activeElement, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('Presentation (.pptx)');
    await key(document.activeElement, 'Enter');
    expect(api.download).toHaveBeenCalledWith(
      '/threads/thread%201/messages/reply-1/export?format=pptx',
    );
  });

  it('is not offered without a saved reply or any text', async () => {
    await mount(TABLE_REPLY, null);
    expect(findButton('Export as…')).toBeUndefined();
    expect(findButton('Copy message')).toBeDefined();
    await cleanup(root!);
    root = undefined;
    await mount('   ');
    expect(findButton('Export as…')).toBeUndefined();
  });
});

describe('export helpers', () => {
  it('offers a spreadsheet only for Markdown with a table outside code', () => {
    expect(exportFormatsFor(TABLE_REPLY)).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);
    expect(exportFormatsFor('```\n| a |\n|---|\n```')).toEqual(['docx', 'pdf', 'pptx']);
  });

  it('reads a bare file name from Content-Disposition', () => {
    expect(dispositionFilename('attachment; filename="plan-v2.docx"')).toBe('plan-v2.docx');
    expect(dispositionFilename("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe(
      'résumé.pdf',
    );
    expect(dispositionFilename('attachment; filename=plain.xlsx')).toBe('plain.xlsx');
    expect(dispositionFilename('attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(dispositionFilename('attachment; filename=".."')).toBeNull();
    expect(dispositionFilename('attachment')).toBeNull();
    expect(dispositionFilename(null)).toBeNull();
  });
});
