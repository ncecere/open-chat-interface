// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import type { ArtifactSummary } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from './admin-test-utils';
import { mockViewport } from './artifacts.fixtures';
import {
  created,
  createPart,
  liveHarness,
  PAGE,
  prompt,
  reply,
  resetLiveArtifactTest,
  savedOutput,
  stream,
} from './artifacts-live.fixtures';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
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
vi.mock('../../src/lib/artifact-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/artifact-sandbox')>()),
  loadArtifactLibraries: async () => ({}),
}));

let root: Root | undefined;
let container: HTMLElement;
let listed: ArtifactSummary[] = [];
const { mount, startLiveReply } = liveHarness({
  container: () => container,
  mounted: (next, element) => {
    root = next;
    container = element;
  },
});

beforeEach(() => {
  listed = [];
  resetLiveArtifactTest(api, () => listed);
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

describe('the live artifact card', () => {
  it('names what is being written from the partial input, with a fallback before the title', async () => {
    await mount();
    await stream([prompt]);
    await stream([prompt, reply(createPart('input-streaming', {}))]);
    const card = container.querySelector<HTMLButtonElement>('[data-artifact-card="tool:call-1"]')!;
    expect(card.textContent).toContain('Preparing artifact…');
    expect(card.hasAttribute('data-live')).toBe(true);
    expect(card.querySelector('[data-streaming-indicator]')).not.toBeNull();

    await stream([prompt, reply(createPart('input-streaming', { title: 'Sign-U', kind: 'ht' }))]);
    expect(card.textContent).toContain('Preparing Sign-U…');
    await stream([
      prompt,
      reply(createPart('input-streaming', { title: 'Sign-Up', kind: 'html', content: '<p>' })),
    ]);
    expect(card.textContent).toContain('Writing Sign-Up…');
    // The raw JSON input is never shown as a tool step.
    expect(container.textContent).not.toContain('"title"');
    expect(container.textContent).not.toContain('Creating artifact');
  });

  it('shows the text growing: line and character counts and the last lines', async () => {
    mockViewport(390);
    const lines = Array.from({ length: 142 }, (_, index) => `<p>line ${index + 1} "quoted"</p>`);
    await startLiveReply({ title: 'Long', kind: 'html', content: lines.slice(0, 2).join('\n') });
    const card = container.querySelector<HTMLButtonElement>('[data-artifact-card="tool:call-1"]')!;
    expect(card.textContent).toContain('HTML · 2 lines');
    await stream([
      prompt,
      reply(
        createPart('input-streaming', {
          title: 'Long',
          kind: 'html',
          content: `${lines.join('\n')}\n`,
        }),
      ),
    ]);
    expect(card.textContent).toContain('HTML · 142 lines');
    const preview = [...card.querySelectorAll('[data-live-preview] > span')].map(
      (line) => line.textContent,
    );
    // The last three lines, unescaped.
    expect(preview).toEqual(lines.slice(-3));
    // The accessible name stays short.
    expect(card.getAttribute('aria-label')).toBe('Open artifact while it is written: Long');
  });

  it('counts the seconds while it waits for any text', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      await startLiveReply({ title: 'Plan' });
      const card = () =>
        container.querySelector<HTMLButtonElement>('[data-artifact-card="tool:call-1"]')!;
      expect(card().textContent).toContain('Preparing Plan…');
      expect(card().textContent).not.toMatch(/\d+ s/);
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(card().textContent).toContain('waiting for text · 5 s');
      await stream([
        prompt,
        reply(createPart('input-streaming', { title: 'Plan', content: '# Plan' })),
      ]);
      expect(card().textContent).toContain('Writing Plan…');
      expect(card().textContent).not.toContain('waiting');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says how many changes a revision by edits makes', async () => {
    listed = [created()];
    await mount();
    await stream([prompt]);
    await stream([
      prompt,
      reply({
        type: 'tool-update_artifact',
        toolCallId: 'call-2',
        state: 'input-streaming',
        input: {
          artifactId: 'art-page',
          edits: [{ find: 'FORM_BODY', replace: 'NEW' }, { find: 'Sign' }],
        },
      } as never),
    ]);
    expect(container.querySelector('[data-artifact-card="tool:call-2"]')?.textContent).toContain(
      'Revising Sign-Up Page… (2 changes)',
    );
  });

  it('becomes the saved card, the same element, once the artifact is saved', async () => {
    mockViewport(390);
    await startLiveReply({ title: 'Sign-Up Page', kind: 'html', content: '<!doctype' });
    const card = container.querySelector<HTMLButtonElement>('[data-artifact-card="tool:call-1"]')!;
    listed = [created()];
    await stream([
      prompt,
      reply(
        createPart(
          'output-available',
          { title: 'Sign-Up Page', kind: 'html', content: PAGE },
          savedOutput,
        ),
      ),
    ]);
    const saved = container.querySelector<HTMLButtonElement>('[data-artifact-card="tool:call-1"]')!;
    expect(saved).toBe(card);
    expect(saved.getAttribute('aria-label')).toBe('Open artifact: Sign-Up Page');
    expect(saved.textContent).toContain('HTML · version 1');
    expect(saved.hasAttribute('data-live')).toBe(false);
  });
});
