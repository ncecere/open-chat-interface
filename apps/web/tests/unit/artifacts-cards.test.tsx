// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import type { PublicArtifact } from '@oci/shared';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicArtifactsProvider } from '../../src/components/artifacts/artifacts-provider';
import { CreatedArtifactCards } from '../../src/components/artifacts/reply-content';
import { MessageRow } from '../../src/components/chat/message-row';
import { ARTIFACT_FRAME_URL } from '../../src/lib/artifact-sandbox';
import { button, cleanup, click, dialog, findButton, pressEscape } from './admin-test-utils';
import {
  conversation,
  frames,
  HTML,
  mountWithQueryClient,
  REPLY,
  reply,
  resetArtifactTest,
} from './artifacts.fixtures';

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

let root: Root | undefined;
beforeEach(() => resetArtifactTest(api));
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.restoreAllMocks();
});

const mount = (ui: ReactNode) =>
  mountWithQueryClient(ui, (next) => {
    root = next;
  });

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
