import type { ArtifactDetail, ArtifactSummary } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Mock } from 'vitest';
import { ThreadArtifactsProvider } from '../../src/components/artifacts/artifacts-provider';
import { PANEL_WIDTH_STORAGE_KEY } from '../../src/components/artifacts/panel-resize';
import { MessageRow } from '../../src/components/chat/message-row';
import { settle } from './admin-test-utils';

/**
 * Shared setup for the artifacts-*.test.tsx files: a reply with saved and
 * unsaved artifacts, the API answers for them, and the render helpers.
 *
 * Each test file declares its own `vi.mock` calls and `api` mock (Vitest
 * hoists them per file) and passes the mock in here.
 */

export type ArtifactApiMock = { get: Mock; post: Mock; download: Mock };

export const HTML = '<!doctype html><title>Chart</title><p>CHART_BODY</p>';
export const REPLY = [
  'Here is your chart:',
  '```html',
  HTML,
  '```',
  'And a flow:',
  '```mermaid',
  'flowchart LR',
  'A --> B',
  'B --> C',
  '```',
  'And an unsaved one:',
  '```svg',
  '<svg>UNSAVED</svg>',
  '```',
].join('\n');

const summary = (overrides: Partial<ArtifactSummary>): ArtifactSummary => ({
  id: 'art-html',
  threadId: 'thread-1',
  messageId: 'reply-1',
  sourceKey: 'block:0',
  title: 'Chart',
  kind: 'html',
  language: null,
  currentVersion: 1,
  sizeBytes: 40,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
export const ARTIFACTS: ArtifactSummary[] = [
  summary({}),
  summary({ id: 'art-flow', sourceKey: 'block:1', title: 'Flowchart', kind: 'mermaid' }),
  summary({
    id: 'art-doc',
    sourceKey: 'tool:c1',
    title: 'Plan',
    kind: 'markdown',
    currentVersion: 2,
  }),
];
export const DOC_DETAIL: ArtifactDetail = {
  artifact: ARTIFACTS[2]!,
  versions: [
    {
      version: 2,
      sizeBytes: 9,
      source: 'person',
      messageId: null,
      createdAt: '2026-01-02T00:00:00.000Z',
    },
    {
      version: 1,
      sizeBytes: 6,
      source: 'reply',
      messageId: 'reply-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  content: '# Plan v2',
};

export const reply: UIMessage = {
  id: 'reply-1',
  role: 'assistant',
  parts: [
    {
      type: 'tool-create_artifact',
      toolCallId: 'c1',
      state: 'output-available',
      input: { title: 'Plan', kind: 'markdown', content: '# Plan v1' },
      output: { artifactId: 'art-doc', title: 'Plan', kind: 'markdown', version: 1, sizeBytes: 9 },
    } as never,
    { type: 'text', text: REPLY },
  ],
};

/** A viewport width for `matchMedia`; phones by default, so the panel is a dialog. */
let viewportWidth = 390;
export function mockViewport(width: number) {
  viewportWidth = width;
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: min ? viewportWidth >= Number(min[1]) : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/** The `beforeEach` of every artifacts test: a phone, no stored width, and the API answers. */
export function resetArtifactTest(api: ArtifactApiMock) {
  mockViewport(390);
  localStorage.removeItem(PANEL_WIDTH_STORAGE_KEY);
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/artifacts?threadId=')) return { artifacts: ARTIFACTS };
    if (path === '/artifacts/art-doc') return DOC_DETAIL;
    if (path === '/artifacts/art-doc/versions/1')
      return { ...DOC_DETAIL.versions[1], content: '# Plan v1' };
    if (path === '/artifacts/art-html')
      return { artifact: ARTIFACTS[0], versions: [DOC_DETAIL.versions[1]], content: HTML };
    throw new Error(`Unexpected GET ${path}`);
  });
}

/**
 * Renders `ui` in a fresh query client that never retries. `onRoot` receives
 * the React root before anything renders, so the test file can unmount it.
 */
export async function mountWithQueryClient(ui: ReactNode, onRoot: (root: Root) => void) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  onRoot(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  );
  await settle();
  return container;
}

export function conversation(canEdit = true) {
  return (
    <ThreadArtifactsProvider
      threadId="thread-1"
      messages={[reply]}
      streaming={false}
      canEdit={canEdit}
    >
      <MessageRow message={reply} streaming={false} editing={false} onEditingChange={() => {}} />
    </ThreadArtifactsProvider>
  );
}

export const frames = () => [...document.querySelectorAll('iframe')];

/** A real Escape key press is cancelable, which is how an open edit keeps the panel open. */
export async function pressCancelableEscape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

/** The element that fills the window while the panel is full screen. */
export const fullScreenPanel = () => document.querySelector<HTMLElement>('[data-full-screen]');
