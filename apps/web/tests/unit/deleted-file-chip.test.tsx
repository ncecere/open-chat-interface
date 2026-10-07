// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageAttachments } from '../../src/components/chat/message-attachments';
import { MessageEditor } from '../../src/components/chat/message-editor';

/**
 * A file its owner deleted keeps its part in the conversation, marked
 * `removed: true` with its name, type and size (#378); the page draws it as
 * removed whether or not the server also sent `available: false`. The real
 * chip and edit box, no mocks.
 */
const deleted = {
  type: 'data-attachment',
  data: {
    id: 'pdf',
    filename: 'timeline.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    url: '/api/attachments/pdf/content',
    removed: true,
  },
};
const live = {
  type: 'data-attachment',
  data: {
    id: 'csv',
    filename: 'hours.csv',
    mimeType: 'text/csv',
    url: '/api/attachments/csv/content',
  },
};
const message = {
  id: 'question',
  role: 'user',
  parts: [{ type: 'text', text: 'Read these' }, deleted, live],
} as unknown as UIMessage;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('draws a deleted file as the struck-through "No longer available" chip, not a link', async () => {
  await act(async () => root.render(<MessageAttachments message={message} />));
  const chips = container.querySelectorAll('[data-attachment-state="removed"]');
  expect(chips).toHaveLength(1);
  const chip = chips[0] as HTMLElement;
  expect(chip.textContent).toContain('timeline.pdf');
  expect(chip.textContent).toContain('No longer available');
  expect(chip.title).toBe('timeline.pdf: no longer available');
  expect(chip.closest('a')).toBeNull();
  expect(chip.querySelector('a, img')).toBeNull();
  const name = [...chip.querySelectorAll('span')].find((s) => s.textContent === 'timeline.pdf');
  expect(name?.className).toContain('line-through');
  // The file that is still there stays a link.
  expect(
    [...container.querySelectorAll('a[href^="/api/attachments/"]')].map((a) =>
      a.getAttribute('href'),
    ),
  ).toEqual(['/api/attachments/csv/content']);
});

it('says "(no longer available)" in the edit box, and Remove still works', async () => {
  const onEdit = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <MessageEditor
        messageId="question"
        initialText="Read these"
        attachments={[deleted.data, live.data]}
        onEdit={onEdit}
        onClose={() => {}}
      />,
    ),
  );
  const items = () =>
    [...container.querySelectorAll('ul[aria-label="Attached files"] li')].map(
      (li) => li.textContent,
    );
  expect(items()).toEqual(['timeline.pdf(no longer available)', 'hours.csv']);
  const remove = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove timeline.pdf"]',
  );
  expect(remove).not.toBeNull();
  await act(async () => remove!.click());
  expect(items()).toEqual(['hours.csv']);
});
