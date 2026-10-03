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
  ArtifactSource,
  HIGHLIGHT_LIMIT,
  sourceLanguage,
} from '../../src/components/artifacts/artifact-source';
import {
  PublicArtifactsProvider,
  ThreadArtifactsProvider,
} from '../../src/components/artifacts/artifacts-provider';
import { CreatedArtifactCards } from '../../src/components/artifacts/reply-content';
import { MessageRow } from '../../src/components/chat/message-row';
import { ApiError } from '../../src/lib/api-client';
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

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), download: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div data-markdown>{children}</div>,
  HighlightedCode: ({ source, language }: { source: string; language: string }) => (
    <pre data-highlighted={language}>
      <code>{source}</code>
    </pre>
  ),
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

/** A viewport width for `matchMedia`; phones by default, so the panel is a dialog. */
let viewportWidth = 390;
function mockViewport(width: number) {
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

let root: Root | undefined;
beforeEach(() => {
  mockViewport(390);
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
    // In the order the reply wrote them: the tool call first, then the text's blocks.
    expect(cards).toEqual([
      'Open artifact: Plan',
      'Open artifact: Chart',
      'Open artifact: Flowchart',
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
    const source = dialog()?.querySelector('pre');
    expect(source?.textContent).toBe(HTML);
    // Highlighted as HTML by the reply renderer; the scrolled view takes keyboard focus.
    expect(source?.getAttribute('data-highlighted')).toBe('html');
    const tabpanel = dialog()?.querySelector('[role="tabpanel"]');
    expect(tabpanel?.getAttribute('aria-label')).toBe('Source');
    expect(tabpanel?.getAttribute('tabindex')).toBe('0');
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

  it('exports a document as a file, the version shown', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:doc'), revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    api.download.mockResolvedValue({ blob: new Blob(['PK']), filename: 'plan-v2.docx' });
    await mount(conversation());
    await click(button('Open artifact: Plan'));
    const exportButton = button('Export as…');
    expect(exportButton.getAttribute('aria-haspopup')).toBe('menu');
    exportButton.focus();
    await act(async () => {
      exportButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    // "# Plan v2" has no table, so no spreadsheet.
    expect(items.map((entry) => entry.textContent)).toEqual([
      'Word document (.docx)',
      'PDF (.pdf)',
      'Presentation (.pptx)',
    ]);
    await click(items[0]!);
    expect(api.download).toHaveBeenCalledWith('/artifacts/art-doc/export?format=docx');
    expect(names).toEqual(['plan-v2.docx']);

    // An older version exports as that version; a refusal is shown in the panel.
    api.download.mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'This content is too long or complex.'),
    );
    await click(button('Versions'));
    await click([...dialog()!.querySelectorAll<HTMLElement>('ol button')][1]!);
    const again = button('Export as…');
    again.focus();
    await act(async () => {
      again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    await click(document.querySelectorAll<HTMLElement>('[role="menuitem"]')[1]!);
    expect(api.download).toHaveBeenLastCalledWith('/artifacts/art-doc/export?format=pdf&version=1');
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      'This content is too long or complex.',
    );
  });

  it('offers file export for documents only', async () => {
    await mount(conversation());
    await click(button('Open artifact: Chart'));
    expect(findButton('Export as…')).toBeUndefined();
  });
});

describe('the panel header', () => {
  it('lays Copy, Download and Close out in their own columns, so Close never covers an action', async () => {
    await mount(conversation());
    await click(button('Open artifact: Plan'));
    const header = dialog()!.querySelector<HTMLElement>('[data-panel-header]')!;
    const close = header.querySelector<HTMLElement>('[data-panel-close]')!;
    const toolbar = header.querySelector<HTMLElement>('[role="toolbar"]')!;
    // Close is a direct item of the header row, after the column holding the
    // title and the actions; nothing is positioned on top of the actions.
    expect(close.parentElement).toBe(header);
    expect(header.lastElementChild).toBe(close);
    expect(close.className).not.toMatch(/\babsolute\b/);
    expect(close.className).toContain('shrink-0');
    expect(toolbar.closest('[data-panel-header] > div')).toBe(header.firstElementChild);
    expect(header.firstElementChild?.className).toContain('flex-wrap');
    expect(header.firstElementChild?.className).toContain('min-w-0');
    expect(dialog()!.querySelectorAll('[aria-label="Close"]')).toHaveLength(1);
    // Accessible names are unchanged.
    expect(findButton('Copy')).toBeDefined();
    expect(findButton('Download')).toBeDefined();
    expect(close.getAttribute('aria-label')).toBe('Close');
    await click(close);
    expect(dialog()).toBeNull();
  });
});

describe('the docked panel', () => {
  it('opens beside the conversation on wide screens, without a dialog or focus trap', async () => {
    mockViewport(1280);
    const container = await mount(conversation());
    const card = button('Open artifact: Chart');
    // Docked, the card opens a region rather than a dialog.
    expect(card.hasAttribute('aria-haspopup')).toBe(false);
    card.focus();
    await click(card);
    expect(dialog()).toBeNull();
    const panel = container.querySelector<HTMLElement>('aside[data-artifact-panel]')!;
    expect(panel).not.toBeNull();
    const heading = document.getElementById(panel.getAttribute('aria-labelledby')!)!;
    expect(heading.textContent).toBe('Chart');
    // The person opened it: focus moves to its heading. Nothing else is inert.
    expect(document.activeElement).toBe(heading);
    expect(container.querySelector('[inert]')).toBeNull();
    expect(document.querySelector('[data-radix-focus-guard]')).toBeNull();
    // Beside the conversation, inside the same layout row.
    expect(panel.parentElement?.hasAttribute('data-artifacts-layout')).toBe(true);
    // Visually hidden live regions are laid out inside positioned boxes, never
    // against an ancestor outside the conversation's scroller.
    for (const hidden of document.querySelectorAll<HTMLElement>('.sr-only')) {
      const box = hidden.parentElement?.closest('.relative, [role="dialog"]');
      expect(box && container.contains(box)).toBe(true);
    }

    // Escape inside the panel closes it and focus goes back to the card.
    await act(async () => {
      heading.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(container.querySelector('aside[data-artifact-panel]')).toBeNull();
    expect(document.activeElement).toBe(button('Open artifact: Chart'));
  });

  it('stays a dialog on share links, whatever the width', async () => {
    mockViewport(1280);
    await mount(
      <PublicArtifactsProvider
        artifacts={[
          {
            messageId: 'reply-1',
            sourceKey: 'tool:c1',
            title: 'Plan',
            kind: 'markdown',
            version: 1,
            content: '# Shared',
          },
        ]}
        markdownProps={{ skipHtml: true }}
      >
        <CreatedArtifactCards messageId="reply-1" />
      </PublicArtifactsProvider>,
    );
    expect(dialog()).toBeNull();
    expect(document.querySelector('aside')).toBeNull();
    await click(button('Open artifact: Plan'));
    expect(dialog()).not.toBeNull();
    expect(document.querySelector('aside')).toBeNull();
  });
});

describe('the source view', () => {
  it("highlights each kind with the reply renderer's language", () => {
    expect(sourceLanguage('html')).toBe('html');
    expect(sourceLanguage('svg')).toBe('xml');
    // `mmd` is Shiki's Mermaid grammar; a `mermaid` fence would draw the diagram.
    expect(sourceLanguage('mermaid')).toBe('mmd');
    expect(sourceLanguage('markdown')).toBe('markdown');
    expect(sourceLanguage(null)).toBe('text');
  });

  it('shows a very large source as plain text with a note', async () => {
    const large = `<p>${'x'.repeat(HIGHLIGHT_LIMIT)}</p>`;
    const container = await mount(<ArtifactSource kind="html" content={large} />);
    expect(container.querySelector('[data-highlighted]')).toBeNull();
    expect(container.querySelector('[data-artifact-source="plain"] pre')?.textContent).toBe(large);
    expect(container.querySelector('[role="note"]')?.textContent).toContain(
      'Syntax highlighting is off',
    );

    await cleanup(root!);
    root = undefined;
    const small = await mount(<ArtifactSource kind="svg" content="<svg/>" />);
    expect(small.querySelector('[data-highlighted]')?.getAttribute('data-highlighted')).toBe('xml');
    expect(small.querySelector('[role="note"]')).toBeNull();
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
        <CreatedArtifactCards messageId="reply-1" />
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

    // Nor is a shared document exported as a file: that needs the owner.
    await pressEscape();
    await click(button('Open artifact: Plan'));
    expect(dialog()?.textContent).toContain('# Shared plan');
    expect(findButton('Export as\u2026')).toBeUndefined();
  });
});
