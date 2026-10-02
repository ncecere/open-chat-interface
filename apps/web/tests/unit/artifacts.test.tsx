// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import type { ArtifactDetail, ArtifactSummary, PublicArtifact } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactFrame } from '../../src/components/artifacts/artifact-frame';
import { artifactFilename } from '../../src/components/artifacts/artifact-panel';
import {
  PublicArtifactsProvider,
  ThreadArtifactsProvider,
} from '../../src/components/artifacts/artifacts-provider';
import { MessageRow } from '../../src/components/chat/message-row';
import { ARTIFACT_FRAME_URL } from '../../src/lib/artifact-sandbox';
import {
  button,
  cleanup,
  click,
  dialog,
  findButton,
  pressEscape,
  settle,
} from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));
// The real loader inlines D3; these tests are about the frame, not the library.
vi.mock('../../src/lib/artifact-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/artifact-sandbox')>()),
  loadArtifactLibraries: async () => ({}),
}));

const HTML = '<!doctype html><title>Chart</title><p>CHART_BODY</p>';
const REPLY = [
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
  currentVersion: 1,
  sizeBytes: 40,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});
const ARTIFACTS: ArtifactSummary[] = [
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
const DOC_DETAIL: ArtifactDetail = {
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

const reply: UIMessage = {
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

let root: Root | undefined;
beforeEach(() => {
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
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.restoreAllMocks();
});

async function mount(ui: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () =>
    root!.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  );
  await settle();
  return container;
}

function conversation(canEdit = true) {
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

const frames = () => [...document.querySelectorAll('iframe')];

/** A real Escape key press is cancelable, which is how an open edit keeps the panel open. */
async function pressCancelableEscape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

describe('artifact cards in a reply', () => {
  it('replace saved HTML blocks, follow Mermaid diagrams and leave unsaved blocks as code', async () => {
    const container = await mount(conversation());
    const cards = [...container.querySelectorAll('[data-artifact-card]')].map((card) =>
      card.getAttribute('aria-label'),
    );
    expect(cards).toEqual([
      'Open artifact: Chart',
      'Open artifact: Flowchart',
      'Open artifact: Plan',
    ]);
    const text = container.textContent ?? '';
    expect(text).not.toContain('CHART_BODY');
    expect(text).toContain('flowchart LR');
    expect(text).toContain('<svg>UNSAVED</svg>');
    expect(button('Open artifact: Chart').textContent).toContain('HTML · version 1');
    // No frame runs until the person opens one.
    expect(frames()).toHaveLength(0);
  });

  it('render as plain Markdown outside a conversation page', async () => {
    const container = await mount(
      <MessageRow message={reply} streaming={false} editing={false} onEditingChange={() => {}} />,
    );
    expect(container.querySelector('[data-artifact-card]')).toBeNull();
    expect(container.textContent).toContain('CHART_BODY');
  });
});

describe('the artifact panel', () => {
  it('opens as a labelled dialog with Preview, Source and Versions, and returns focus on close', async () => {
    await mount(conversation());
    const card = button('Open artifact: Chart');
    card.focus();
    await click(card);
    const panel = dialog();
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(panel!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Chart',
    );
    const tabs = [...panel!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['Preview', 'Source', 'Versions']);
    expect(panel?.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(panel?.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Artifact');

    const [frame] = frames();
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('src')).toBe(ARTIFACT_FRAME_URL);

    await click(button('Source'));
    expect(dialog()?.querySelector('pre')?.textContent).toBe(HTML);
    expect(frames()).toHaveLength(0);

    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button('Open artifact: Chart'));
  });

  it('moves between tabs with the arrow keys', async () => {
    await mount(conversation());
    await click(button('Open artifact: Chart'));
    const preview = button('Preview');
    preview.focus();
    await act(async () => {
      preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await settle();
    expect(document.activeElement).toBe(button('Source'));
    expect(button('Source').getAttribute('aria-selected')).toBe('true');
  });

  it('lists versions and shows an older one', async () => {
    await mount(conversation());
    await click(button('Open artifact: Plan'));
    expect(dialog()?.textContent).toContain('Document · version 2');
    await click(button('Versions'));
    const entries = [...dialog()!.querySelectorAll('ol button')].map((entry) => entry.textContent);
    expect(entries[0]).toContain('Version 2 (current)');
    expect(entries[0]).toContain('Edited by you');
    expect(entries[1]).toContain('By the assistant');
    const older = [...dialog()!.querySelectorAll('ol button')][1] as HTMLButtonElement;
    await click(older);
    expect(api.get).toHaveBeenCalledWith('/artifacts/art-doc/versions/1', expect.anything());
    expect(dialog()?.textContent).toContain('# Plan v1');
    expect(dialog()?.textContent).toContain('version 1 of 2');
    // Older versions are read-only.
    expect(findButton('Edit')).toBeUndefined();
  });

  it('edits a document as a new version from the current one', async () => {
    api.post.mockResolvedValue({ artifact: { ...ARTIFACTS[2], currentVersion: 3 } });
    await mount(conversation());
    await click(button('Open artifact: Plan'));
    await click(button('Edit'));
    const editor = dialog()!.querySelector('textarea')!;
    expect(document.activeElement).toBe(editor);
    expect(dialog()?.querySelector(`label[for="${editor.id}"]`)?.textContent).toBe('Edit document');
    expect(button('Save as new version').disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor, '# Plan v3');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await click(button('Save as new version'));
    expect(api.post).toHaveBeenCalledWith('/artifacts/art-doc/versions', {
      content: '# Plan v3',
      baseVersion: 2,
    });
    expect(dialog()?.querySelector('textarea')).toBeNull();
  });

  it('leaves an edit with Escape before closing, and offers no edit without the role switch', async () => {
    await mount(conversation());
    await click(button('Open artifact: Plan'));
    await click(button('Edit'));
    await pressCancelableEscape();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('textarea')).toBeNull();
    await pressCancelableEscape();
    expect(dialog()).toBeNull();

    await cleanup(root!);
    root = undefined;
    await mount(conversation(false));
    await click(button('Open artifact: Plan'));
    expect(findButton('Edit')).toBeUndefined();
  });

  it('offers HTML only through the model, never a direct edit', async () => {
    await mount(conversation());
    await click(button('Open artifact: Chart'));
    expect(findButton('Edit')).toBeUndefined();
    expect(findButton('Copy')).toBeDefined();
    expect(findButton('Download')).toBeDefined();
  });

  it('copies and downloads the shown content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const createObjectURL = vi.fn(() => 'blob:artifact');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    await mount(conversation());
    await click(button('Open artifact: Plan'));
    await click(button('Copy'));
    expect(writeText).toHaveBeenCalledWith('# Plan v2');
    expect(dialog()?.textContent).toContain('Copied');
    await click(button('Download'));
    expect(createObjectURL).toHaveBeenCalled();
    expect(artifactFilename('Plan: Q3 / Q4!', 'markdown')).toBe('plan-q3-q4.md');
    expect(artifactFilename('***', 'html')).toBe('artifact.html');
  });
});

describe('the sandboxed frame', () => {
  it('answers only its own frame, once, with the document', async () => {
    await mount(<ArtifactFrame kind="html" content="<p>FRAME</p>" title="Test" />);
    const [frame] = frames();
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.getAttribute('title')).toBe('Test');
    for (const flag of ['allow-same-origin', 'allow-top-navigation', 'allow-popups'])
      expect(frame?.getAttribute('sandbox')).not.toContain(flag);
    expect(frame?.hasAttribute('srcdoc')).toBe(false);

    // The frame's window, as a browser would expose it (frames are not loaded in tests).
    const postMessage = vi.fn();
    const target = { postMessage } as unknown as Window;
    Object.defineProperty(frame, 'contentWindow', { value: target, configurable: true });
    // A message from anywhere else is ignored.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'oci-artifact-ready' }, source: window }),
      );
    });
    expect(postMessage).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'oci-artifact-ready' }, source: target }),
      );
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'oci-artifact-ready' }, source: target }),
      );
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [payload, origin] = postMessage.mock.calls[0] as unknown as [
      { type: string; html: string },
      string,
    ];
    expect(origin).toBe('*');
    expect(payload.type).toBe('oci-artifact');
    expect(payload.html).toContain("default-src 'none'");
    expect(payload.html).toContain('<p>FRAME</p>');
  });
});

describe('artifacts on share links', () => {
  const shared: PublicArtifact[] = [
    {
      messageId: 'reply-1',
      sourceKey: 'block:0',
      title: 'Chart',
      kind: 'html',
      version: 1,
      content: HTML,
    },
    {
      messageId: 'reply-1',
      sourceKey: 'tool:c1',
      title: 'Plan',
      kind: 'markdown',
      version: 1,
      content: '# Shared plan',
    },
  ];

  it('open read-only in the same sandbox, without versions or the API', async () => {
    const message: UIMessage = {
      id: 'reply-1',
      role: 'assistant',
      parts: [{ type: 'text', text: REPLY }],
    };
    await mount(
      <PublicArtifactsProvider artifacts={shared} markdownProps={{ skipHtml: true }}>
        <MessageRow
          message={message}
          streaming={false}
          editing={false}
          onEditingChange={() => {}}
        />
      </PublicArtifactsProvider>,
    );
    await click(button('Open artifact: Chart'));
    const tabs = [...dialog()!.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['Preview', 'Source']);
    const [frame] = frames();
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('src')).toBe(ARTIFACT_FRAME_URL);
    expect(findButton('Edit')).toBeUndefined();
    expect(api.get).not.toHaveBeenCalled();
  });
});
