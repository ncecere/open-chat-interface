// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPickerOption } from '../../src/components/chat/model-picker-presentation';
import { CommandPalette } from '../../src/components/command-palette/command-palette';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { ACCENTS, contrast, MODES, resolveColor, styleFor, tokens } from './css-test-utils';

/**
 * #188: on the highlighted row of the model picker and ⌘K, the secondary
 * line (a model's description, a search result's snippet) was #898989 on
 * #262626 in dark, 4.32:1. The real rows, with their compiled CSS resolved
 * against tokens.css down the tree, as the browser cascades custom properties.
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
    title: 'Walk3 lighthouse',
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
  titleHighlight: 'Walk3 lighthouse',
  matches: [{ messageId: 'm1', role: 'user', snippet: 'a story about a lighthouse' }],
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

const MODEL = {
  id: 'm1',
  slug: 'm1',
  displayName: 'Claude Haiku 4.5',
  description: 'Fast and cheap everyday model',
  providerId: 'p',
  providerKind: 'openai-compatible',
  providerLabel: 'P',
  upstreamModelId: 'm1',
  capabilities: [],
  labId: 'anthropic',
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  isDefault: false,
  sortOrder: 0,
} as unknown as CatalogModel;

/**
 * The contrast of `text` on `row`'s background: each element from the row down
 * sets its custom properties (resolved where declared), then its colours.
 */
async function shownContrast(
  text: Element,
  row: Element,
  mode: (typeof MODES)[number],
  accent: (typeof ACCENTS)[number],
): Promise<number> {
  const chain: Element[] = [];
  for (let node: Element | null = text; node; node = node.parentElement) {
    chain.unshift(node);
    if (node === row) break;
  }
  const values = tokens(mode, accent);
  let color: string | undefined;
  let background: string | undefined;
  for (const node of chain) {
    const style = await styleFor(node.getAttribute('class') ?? '');
    for (const [property, value] of Object.entries(style)) {
      if (property.startsWith('--') && !property.startsWith('--tw-'))
        values[property] = resolveColor(value, values);
    }
    if (style['background-color']) background = resolveColor(style['background-color'], values);
    if (style.color) color = resolveColor(style.color, values);
  }
  if (!color || !background) throw new Error('No colour or background found');
  return contrast(color, background);
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe('secondary text on a highlighted row (#188)', () => {
  it('model picker: the description clears 4.5:1 on the selected row', async () => {
    await act(async () =>
      root.render(
        <ThemeProvider>
          <ModelPickerOption
            model={MODEL}
            selected
            active
            canShowDetails={false}
            detailsOpen={false}
            onSelect={vi.fn()}
            onDetails={vi.fn()}
          />
        </ThemeProvider>,
      ),
    );
    const row = container.firstElementChild!;
    const description = [...row.querySelectorAll('span')].find(
      (span) => span.textContent === 'Fast and cheap everyday model',
    )!;
    for (const mode of MODES)
      for (const accent of ACCENTS)
        expect(
          await shownContrast(description, row, mode, accent),
          `${mode} ${accent}`,
        ).toBeGreaterThanOrEqual(4.5);
  });

  it('⌘K: a search result snippet clears 4.5:1 on the active row', async () => {
    await act(async () =>
      root.render(
        <CommandPalette open onOpenChange={vi.fn()} sidebarOpen onSidebarOpenChange={vi.fn()} />,
      ),
    );
    const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'lighthouse',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    const row = document.querySelector('[role="option"][aria-selected="true"]')!;
    const snippet = [...row.querySelectorAll('span')].find((span) =>
      span.textContent?.startsWith('You: '),
    )!;
    expect(snippet).toBeDefined();
    for (const mode of MODES)
      for (const accent of ACCENTS)
        expect(
          await shownContrast(snippet, row, mode, accent),
          `${mode} ${accent}`,
        ).toBeGreaterThanOrEqual(4.5);
  });
});
