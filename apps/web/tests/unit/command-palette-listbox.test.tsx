// @vitest-environment happy-dom
import { SEARCH_HIGHLIGHT_END as END, SEARCH_HIGHLIGHT_START as START } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../../src/components/command-palette/command-palette';

/**
 * The ⌘K results (#176): options of a listbox, not buttons in the Tab order,
 * and matched words highlighted without extra space around them. The real
 * palette, result rendering and highlighting; only data and navigation are fakes.
 */
const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mocks.navigate,
  useParams: () => ({}),
}));
vi.mock('../../src/hooks/use-threads', () => ({
  useCreateThread: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
const RESULT = {
  thread: {
    id: 't1',
    title: 'Walk3 lighthouse keeper',
    pinned: false,
    archived: false,
    temporary: false,
    expiresAt: null,
    parentThreadId: null,
    branchedFromMessageId: null,
    projectId: null,
    lastMessageAt: null,
    createdAt: '2026-10-05T12:00:00Z',
    updatedAt: '2026-10-05T12:00:00Z',
  },
  rank: 1,
  titleHighlight: `Walk3 ${START}lighthouse${END} ${START}keeper${END}`,
  matches: [
    {
      messageId: 'm1',
      role: 'user',
      snippet: `a story about a ${START}lighthouse${END} ${START}keeper${END} at night`,
    },
  ],
};
vi.mock('../../src/hooks/use-thread-search', () => ({
  SEARCH_DEBOUNCE_MS: 0,
  useThreadSearch: (query: string) => ({
    data: query ? [RESULT] : [],
    isFetching: false,
    isError: false,
    isPlaceholderData: false,
  }),
  useDebouncedValue: (value: unknown) => value,
  searchResultTarget: () => ({ to: '/chat/$threadId', params: { threadId: 't1' } }),
  searchResultsAnnouncement: () => '',
}));
vi.mock('../../src/components/command-palette/use-palette-actions', () => ({
  usePaletteActions: () => [],
}));

let root: Root;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CommandPalette open onOpenChange={vi.fn()} sidebarOpen onSidebarOpenChange={vi.fn()} />,
    ),
  );
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'lighthouse keeper',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

const listbox = () => document.querySelector('[role="listbox"]')!;

describe('command palette results (#176)', () => {
  it('are options of the listbox, outside the Tab order, chosen with a click', async () => {
    const options = [...listbox().querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(listbox().querySelector('button')).toBeNull();
    for (const option of options) expect(option.tabIndex).toBe(-1);
    const input = document.querySelector('input[role="combobox"]')!;
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    await act(async () => options[0]!.click());
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/chat/$threadId',
      params: { threadId: 't1' },
    });
  });

  it('highlights matched words with no space added around them', () => {
    const option = listbox().querySelector('[role="option"]')!;
    expect(option.textContent).toContain('a story about a lighthouse keeper at night');
    const marks = [...option.querySelectorAll('mark')];
    expect(marks.map((mark) => mark.textContent)).toEqual([
      'lighthouse',
      'keeper',
      'lighthouse',
      'keeper',
    ]);
    for (const mark of marks) expect(mark.className).not.toMatch(/\bp[xlr]-/);
  });
});
