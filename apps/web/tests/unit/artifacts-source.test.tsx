// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactFrame } from '../../src/components/artifacts/artifact-frame';
import {
  ArtifactSource,
  HIGHLIGHT_LIMIT,
  sourceLanguage,
} from '../../src/components/artifacts/artifact-source';
import { cleanup } from './admin-test-utils';
import { frames, mountWithQueryClient, resetArtifactTest } from './artifacts.fixtures';

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
