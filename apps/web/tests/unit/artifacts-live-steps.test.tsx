// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import type { ArtifactSummary } from '@oci/shared';
import type { UIMessage } from 'ai';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, cleanup, click, dialog, findButton } from './admin-test-utils';
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
const { mount } = liveHarness({
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

describe('a reply that reasoned, created an artifact, then reasoned again', () => {
  const twoStep = (state: 'writing' | 'saved') =>
    reply(
      { type: 'step-start' },
      { type: 'reasoning', text: 'They want a sign-up page.' },
      state === 'saved'
        ? createPart(
            'output-available',
            { title: 'Sign-Up Page', kind: 'html', content: PAGE },
            savedOutput,
          )
        : createPart('input-streaming', { title: 'Sign-Up Page', kind: 'html', content: '<p>' }),
      ...(state === 'saved'
        ? ([
            { type: 'step-start' },
            { type: 'reasoning', text: 'Now explain it.' },
            { type: 'text', text: 'Your page is ready.' },
          ] as UIMessage['parts'])
        : []),
    );
  const article = () =>
    container.querySelector<HTMLElement>('article[aria-label="Assistant message"]')!;
  const block = () => article().querySelector<HTMLElement>('[data-reply-group="work"]')!;
  const card = () => article().querySelector<HTMLElement>('[data-artifact-card="tool:call-1"]')!;

  it('shows one block summarising the work, the card below it and the answer last', async () => {
    listed = [created()];
    await mount([prompt, twoStep('saved')]);
    // One block, no second "Reasoning", no loose "Details" link.
    expect(article().querySelectorAll('[data-reply-group="reasoning"]')).toHaveLength(0);
    expect(article().querySelectorAll('[data-reply-group="work"]')).toHaveLength(1);
    const header = block().querySelector('button')!;
    expect(header.textContent).toBe('Thought · created an artifact');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(findButton('Details')).toBeUndefined();
    // The card is outside the collapsed block, above the answer.
    expect(block().contains(card())).toBe(false);
    expect(card().getAttribute('aria-label')).toBe('Open artifact: Sign-Up Page');
    const answer = article().querySelector('[data-reply-group="text"]')!;
    expect(block().compareDocumentPosition(card()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card().compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists the artifact as a compact row in the timeline that leads to its card', async () => {
    listed = [created()];
    await mount([prompt, twoStep('saved')]);
    await click(block().querySelector('button')!);
    const items = [...block().querySelectorAll('ol[aria-label="Steps"] > li')];
    expect(items.map((item) => item.getAttribute('data-work-entry'))).toEqual([
      'reasoning',
      'tool',
      'reasoning',
    ]);
    // Not the full card: one line naming what was made.
    expect(block().querySelector('[data-artifact-card]')).toBeNull();
    const row = items[1]!.querySelector<HTMLButtonElement>('button')!;
    expect(row.textContent).toContain("Created artifact 'Sign-Up Page'");
    await click(row);
    expect(document.activeElement).toBe(card());
  });

  it('shows the live card below the block at once while the block says what is written', async () => {
    mockViewport(390);
    await mount();
    await stream([prompt]);
    await stream([prompt, twoStep('writing')]);
    expect(block().querySelector('button')!.textContent).toBe('Writing Sign-Up Page…');
    expect(block().getAttribute('data-work')).toBe('active');
    expect(card().hasAttribute('data-live')).toBe(true);
    expect(card().textContent).toContain('Writing Sign-Up Page…');
    expect(block().contains(card())).toBe(false);
    expect(article().querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      'Writing an artifact…',
    );
  });
});

describe('artifact tool call details', () => {
  async function renderSteps(message: UIMessage, streaming: boolean) {
    await mount([prompt, message], streaming);
  }
  const details = (name: string) => button(`Show details for ${name}`);
  const step = (id = 'call-1') =>
    container.querySelector<HTMLElement>(`[data-artifact-step="${id}"]`)!;

  it('open from a chevron inside the card, closed by default', async () => {
    listed = [created()];
    await renderSteps(
      reply(
        createPart(
          'output-available',
          { title: 'Sign-Up Page', kind: 'html', content: PAGE },
          savedOutput,
        ),
      ),
      false,
    );
    const toggle = details('Sign-Up Page');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(step().contains(toggle)).toBe(true);
    expect(container.querySelector('[data-artifact-details]')).toBeNull();
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = container.querySelector<HTMLElement>('[data-artifact-details]')!;
    expect(panel.id).toBe(toggle.getAttribute('aria-controls'));
    // Inside the card's own border, not beside it.
    expect(step().contains(panel)).toBe(true);
    // The card body still opens the panel.
    await click(button('Open artifact: Sign-Up Page'));
    expect(container.querySelector('[data-artifact-panel]') ?? dialog()).not.toBeNull();
  });

  it('summarise a saved call readably, never as JSON, with a way to open that version', async () => {
    listed = [created({ currentVersion: 2 })];
    await renderSteps(
      reply(
        createPart(
          'output-available',
          { title: 'Sign-Up Page', kind: 'html', content: 'a\n"quoted"\nc' },
          savedOutput,
        ),
      ),
      false,
    );
    await click(details('Sign-Up Page'));
    const text = container.textContent ?? '';
    expect(text).toContain('Title');
    expect(text).toContain('HTML');
    expect(text).toContain('3 lines · 12 characters');
    expect(text).not.toContain('{');
    expect(text).not.toContain('\\"');
    await click(button('Open artifact (version 1)'));
    expect(api.get).toHaveBeenCalledWith('/artifacts/art-page/versions/1', expect.anything());
  });

  it('list each edit as a before and after snippet', async () => {
    listed = [created()];
    await renderSteps(
      reply({
        type: 'tool-update_artifact',
        toolCallId: 'call-2',
        state: 'output-available',
        input: { artifactId: 'art-page', edits: [{ find: '<b>"old"</b>', replace: '<i>new</i>' }] },
        output: { artifactId: 'art-page', title: 'Sign-Up Page', kind: 'html', version: 2 },
      } as never),
      false,
    );
    expect(button('Open artifact: Sign-Up Page').textContent).toContain(
      'Updated · HTML · version 2',
    );
    await click(details('Sign-Up Page'));
    const changes = container.querySelector('[aria-label="Changes"]')!;
    const snippets = [...changes.querySelectorAll('pre')].map((pre) => pre.textContent);
    expect(snippets).toEqual(['<b>"old"</b>', '<i>new</i>']);
    expect(container.textContent).toContain('1 change');
  });

  it('show the live source while it is written, with a way to the panel', async () => {
    mockViewport(390);
    await mount();
    await stream([prompt]);
    await stream([
      prompt,
      reply(createPart('input-streaming', { title: 'Live', content: `${'x'.repeat(2_000)}END` })),
    ]);
    await click(details('Live'));
    const latest = container.querySelector('[aria-label="Latest source"]')!;
    expect(latest.textContent?.startsWith('…')).toBe(true);
    expect(latest.textContent?.endsWith('END')).toBe(true);
    expect(latest.textContent!.length).toBeLessThan(1_300);
    await click(button('Show in panel'));
    expect(dialog()?.querySelector('[data-draft-source]')).not.toBeNull();
  });

  it('show a failed call as a step line with its error', async () => {
    await renderSteps(
      reply(
        createPart('output-error', { title: 'Broken', kind: 'html' }, { errorText: 'Too large.' }),
      ),
      false,
    );
    expect(container.querySelector('[data-artifact-card]')).toBeNull();
    // Nothing was made: the block says so, and its row has the details.
    const block = container.querySelector<HTMLElement>('[data-reply-group="work"]')!;
    expect(block.querySelector('button')?.textContent).toBe('A step failed');
    await click(block.querySelector('button')!);
    await click(button('Creating an artifact failed'));
    expect(container.textContent).toContain('Too large.');
  });

  it('keep the JSON inputs view for other tools', async () => {
    const search: UIMessage = reply({
      type: 'tool-web_search',
      toolCallId: 's1',
      state: 'output-available',
      input: { query: 'hours' },
      output: { query: 'hours', results: [] },
    } as never);
    await renderSteps(search, false);
    await click(button('Searched the web'));
    await click(button("Searched the web for 'hours' · 0 results"));
    expect(container.textContent).toContain('"query": "hours"');
    expect(container.querySelector('[aria-label^="Show details for"]')).toBeNull();
  });
});
