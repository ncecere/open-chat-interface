// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import type { ArtifactSummary } from '@oci/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PublicArtifactsProvider,
  ThreadArtifactsProvider,
} from '../../src/components/artifacts/artifacts-provider';
import { CreatedArtifactCards } from '../../src/components/artifacts/reply-content';
import { MessageList } from '../../src/components/chat/message-list';
import { ToolSteps } from '../../src/components/chat/tool-steps';
import { button, cleanup, click, dialog, findButton, settle } from './admin-test-utils';

/**
 * Live artifacts (v0.9): the card and panel while a reply writes an artifact
 * through the tools, opening the panel by itself on wide screens, and the
 * readable details of an artifact tool call.
 */

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

let viewportWidth = 1280;
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

const PAGE = '<!doctype html><title>Sign up</title><form>FORM_BODY</form>';
const created = (overrides: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
  id: 'art-page',
  threadId: 'thread-1',
  messageId: 'reply-1',
  sourceKey: 'tool:call-1',
  title: 'Sign-Up Page',
  kind: 'html',
  currentVersion: 1,
  sizeBytes: PAGE.length,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

let listed: ArtifactSummary[] = [];
const prompt: UIMessage = {
  id: 'prompt-1',
  role: 'user',
  parts: [{ type: 'text', text: 'A page' }],
};

function createPart(state: string, input: Record<string, unknown>, extra = {}) {
  return { type: 'tool-create_artifact', toolCallId: 'call-1', state, input, ...extra } as never;
}
function reply(...parts: UIMessage['parts']): UIMessage {
  return { id: 'reply-1', role: 'assistant', parts };
}
const savedOutput = {
  output: { artifactId: 'art-page', title: 'Sign-Up Page', kind: 'html', version: 1, sizeBytes: 9 },
};

let root: Root | undefined;
let container: HTMLElement;
let setConversation: (messages: UIMessage[], streaming: boolean) => void = () => {};

function Conversation({ initial, streaming }: { initial: UIMessage[]; streaming: boolean }) {
  const [state, setState] = useState({ messages: initial, streaming });
  setConversation = (messages, next) => setState({ messages, streaming: next });
  return (
    <ThreadArtifactsProvider
      threadId="thread-1"
      messages={state.messages}
      streaming={state.streaming}
      canEdit
    >
      <MessageList messages={state.messages} streaming={state.streaming} onRetry={() => {}} />
      <textarea aria-label="Message input" />
    </ThreadArtifactsProvider>
  );
}

async function mount(initial: UIMessage[] = [prompt], streaming = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <Conversation initial={initial} streaming={streaming} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function stream(messages: UIMessage[], streaming = true) {
  await act(async () => setConversation(messages, streaming));
  await settle();
}
/** Highlighting a source being written is throttled; let it catch up. */
const caughtUp = () => act(() => new Promise((resolve) => setTimeout(resolve, 450)));

const docked = () => container.querySelector<HTMLElement>('aside[data-artifact-panel]');
const announcer = () => container.parentElement!.querySelector('[data-artifact-announcer]');
const composer = () =>
  container.querySelector<HTMLTextAreaElement>('[aria-label="Message input"]')!;

/** A reply written in this tab: sent, then streaming its artifact call. */
async function startLiveReply(input: Record<string, unknown>) {
  await mount();
  composer().focus();
  await stream([prompt]);
  await stream([prompt, reply(createPart('input-streaming', input))]);
}

beforeEach(() => {
  mockViewport(1280);
  localStorage.clear();
  listed = [];
  api.get.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/artifacts?threadId=')) return { artifacts: listed };
    const id = /^\/artifacts\/([^/?]+)$/.exec(path)?.[1];
    const artifact =
      listed.find((entry) => entry.id === id) ?? (id === 'art-page' ? created() : null);
    if (artifact)
      return {
        artifact,
        versions: [
          {
            version: 1,
            sizeBytes: 9,
            source: 'reply',
            messageId: 'reply-1',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        content: PAGE,
      };
    throw new Error(`Unexpected GET ${path}`);
  });
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

describe('watching an artifact being written', () => {
  it('opens docked on the streaming source, then switches to the saved preview', async () => {
    await startLiveReply({ title: 'Sign-Up Page', kind: 'html', content: '<!doctype html>' });
    const panel = docked()!;
    expect(panel).not.toBeNull();
    expect(dialog()).toBeNull();
    const source = panel.querySelector<HTMLElement>('[data-draft-source]')!;
    expect(source.getAttribute('aria-busy')).toBe('true');
    expect(source.getAttribute('aria-label')).toBe('Source of Sign-Up Page');
    expect(source.textContent).toContain('<!doctype html>');
    expect(source.querySelector('[data-highlighted]')?.getAttribute('data-highlighted')).toBe(
      'html',
    );
    expect(panel.querySelector('[data-writing-status]')?.textContent).toBe('Writing Sign-Up Page…');
    expect(announcer()?.textContent).toBe('Opened artifact: Sign-Up Page');
    // Focus stays where the person was.
    expect(document.activeElement).toBe(composer());

    await caughtUp();
    await stream([
      prompt,
      reply(createPart('input-streaming', { title: 'Sign-Up Page', kind: 'html', content: PAGE })),
    ]);
    await caughtUp();
    expect(docked()?.querySelector('[data-draft-source]')?.textContent).toContain('FORM_BODY');
    // Each token is not announced.
    expect(docked()?.querySelector('[data-writing-status]')?.textContent).toBe(
      'Writing Sign-Up Page…',
    );

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
    // Saved: the list is read at once and the panel shows the preview.
    expect(api.get).toHaveBeenCalledWith('/artifacts/art-page', expect.anything());
    expect(docked()?.querySelector('[data-draft-source]')).toBeNull();
    expect(docked()?.querySelector('iframe[data-artifact-frame]')).not.toBeNull();
    expect(docked()?.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Preview',
    );
    expect(docked()?.querySelector('[data-writing-status]')?.textContent).toBe(
      'Finished writing Sign-Up Page.',
    );
    expect(document.activeElement).toBe(composer());
  });

  it('follows the end of the source until the person scrolls up', async () => {
    await startLiveReply({ title: 'Long', kind: 'html', content: 'line\n' });
    const source = docked()!.querySelector<HTMLElement>('[data-draft-source]')!;
    let top = 0;
    Object.defineProperty(source, 'scrollHeight', { configurable: true, get: () => 5_000 });
    Object.defineProperty(source, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(source, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    await stream([
      prompt,
      reply(createPart('input-streaming', { title: 'Long', content: 'line\n'.repeat(50) })),
    ]);
    expect(top).toBe(5_000);

    top = 100;
    await act(async () => {
      source.dispatchEvent(new Event('scroll'));
    });
    await stream([
      prompt,
      reply(createPart('input-streaming', { title: 'Long', content: 'line\n'.repeat(80) })),
    ]);
    expect(top).toBe(100);
  });

  it('keeps the draft when the person opened another artifact meanwhile', async () => {
    listed = [
      created({ id: 'art-old', messageId: 'old-reply', sourceKey: 'block:0', title: 'Old' }),
    ];
    const old: UIMessage = {
      id: 'old-reply',
      role: 'assistant',
      parts: [{ type: 'text', text: ['```html', '<!doctype html><p>old</p>', '```'].join('\n') }],
    };
    await mount([prompt, old]);
    await stream([prompt, old]);
    await stream([
      prompt,
      old,
      { ...prompt, id: 'prompt-2' },
      reply(createPart('input-streaming', { title: 'New' })),
    ]);
    expect(docked()?.querySelector('[data-draft-source]')).not.toBeNull();
    await click(button('Open artifact: Old'));
    expect(document.getElementById(docked()!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Old',
    );
    listed = [...listed, created({ title: 'New' })];
    await stream([
      prompt,
      old,
      { ...prompt, id: 'prompt-2' },
      reply(
        createPart('output-available', { title: 'New', kind: 'html', content: PAGE }, savedOutput),
      ),
    ]);
    expect(document.getElementById(docked()!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Old',
    );
  });
});

describe('opening artifacts automatically', () => {
  it('never opens for a reply loaded from history or resumed after a reload', async () => {
    listed = [created()];
    const stored = reply(
      createPart(
        'output-available',
        { title: 'Sign-Up Page', kind: 'html', content: PAGE },
        savedOutput,
      ),
    );
    await mount([prompt, stored]);
    expect(docked()).toBeNull();
    await cleanup(root!);
    root = undefined;

    // Reloaded mid-reply: the partial reply is history, even as it resumes.
    const partial = reply(createPart('input-streaming', { title: 'Sign-Up Page', content: '<p>' }));
    await mount([prompt, partial], false);
    await stream([prompt, partial], true);
    await stream([
      prompt,
      reply(createPart('input-streaming', { title: 'Sign-Up Page', content: '<p>more' })),
    ]);
    expect(docked()).toBeNull();
    expect(container.querySelector('[data-artifact-card="tool:call-1"]')?.textContent).toContain(
      'Writing Sign-Up Page…',
    );
  });

  it('never opens in full screen, and leaves full screen as the person set it', async () => {
    await startLiveReply({ title: 'Sign-Up Page', kind: 'html', content: '<!doctype html>' });
    const panel = docked()!;
    expect(panel.hasAttribute('data-full-screen')).toBe(false);
    expect(panel.getAttribute('role')).toBeNull();
    expect(dialog()).toBeNull();
    expect(findButton('Full screen')).toBeDefined();
    expect(container.querySelector('[inert]')).toBeNull();
    expect(document.activeElement).toBe(composer());

    // The person goes full screen on the source; saving swaps in the preview
    // without leaving full screen.
    await click(button('Full screen'));
    expect(dialog()).toBe(panel);
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
    expect(docked()?.querySelector('iframe[data-artifact-frame]')).not.toBeNull();
    expect(docked()?.hasAttribute('data-full-screen')).toBe(true);
    expect(findButton('Exit full screen')).toBeDefined();
  });

  it('does not replace what the person is looking at full screen', async () => {
    listed = [
      created({ id: 'art-old', messageId: 'old-reply', sourceKey: 'block:0', title: 'Old' }),
    ];
    const old: UIMessage = {
      id: 'old-reply',
      role: 'assistant',
      parts: [{ type: 'text', text: ['```html', '<!doctype html><p>old</p>', '```'].join('\n') }],
    };
    await mount([prompt, old]);
    await click(button('Open artifact: Old'));
    await click(button('Full screen'));
    const heading = () => document.getElementById(docked()!.getAttribute('aria-labelledby')!);
    await stream([prompt, old, { ...prompt, id: 'prompt-2' }]);
    await stream([
      prompt,
      old,
      { ...prompt, id: 'prompt-2' },
      reply(createPart('input-streaming', { title: 'New', content: '<p>' })),
    ]);
    expect(heading()?.textContent).toBe('Old');
    expect(docked()?.hasAttribute('data-full-screen')).toBe(true);
    // Leaving full screen later does not bring the new one in either.
    await click(button('Exit full screen'));
    await stream([
      prompt,
      old,
      { ...prompt, id: 'prompt-2' },
      reply(createPart('input-streaming', { title: 'New', content: '<p>more' })),
    ]);
    expect(heading()?.textContent).toBe('Old');
  });

  it('does not open when the person turned it off', async () => {
    localStorage.setItem('oci.autoOpenArtifacts', 'false');
    await startLiveReply({ title: 'Sign-Up Page', content: '<p>' });
    expect(docked()).toBeNull();
    // The card still opens it.
    await click(container.querySelector<HTMLButtonElement>('[data-artifact-card="tool:call-1"]')!);
    expect(docked()?.querySelector('[data-draft-source]')?.textContent).toContain('<p>');
  });

  it('does not reopen what the person closed during the reply', async () => {
    await startLiveReply({ title: 'Sign-Up Page', content: '<p>' });
    await click(docked()!.querySelector<HTMLElement>('[data-panel-close]')!);
    expect(docked()).toBeNull();
    await stream([
      prompt,
      reply(createPart('input-streaming', { title: 'Sign-Up Page', content: '<p>x' })),
    ]);
    listed = [created()];
    await stream(
      [
        prompt,
        reply(
          createPart(
            'output-available',
            { title: 'Sign-Up Page', kind: 'html', content: PAGE },
            savedOutput,
          ),
        ),
      ],
      false,
    );
    expect(docked()).toBeNull();
  });

  it("opens the first artifact of a finished reply's code blocks, without moving focus", async () => {
    await mount();
    composer().focus();
    await stream([prompt]);
    const text = ['Here:', '```html', '<!doctype html><title>Card</title><p>x</p>', '```'].join(
      '\n',
    );
    const finished: UIMessage = {
      id: 'reply-1',
      role: 'assistant',
      parts: [{ type: 'text', text }],
    };
    await stream([prompt, finished]);
    expect(docked()).toBeNull();
    listed = [created({ id: 'art-card', sourceKey: 'block:0', title: 'Card' })];
    await stream([prompt, finished], false);
    expect(docked()).not.toBeNull();
    expect(document.getElementById(docked()!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Card',
    );
    expect(announcer()?.textContent).toBe('Opened artifact: Card');
    expect(document.activeElement).toBe(composer());
  });

  it('does not open on narrow screens; the live card opens the dialog on the source', async () => {
    mockViewport(390);
    await startLiveReply({ title: 'Sign-Up Page', kind: 'html', content: '<p>PHONE</p>' });
    expect(dialog()).toBeNull();
    expect(docked()).toBeNull();
    const card = container.querySelector<HTMLButtonElement>('[data-artifact-card="tool:call-1"]')!;
    expect(card.textContent).toContain('Writing Sign-Up Page…');
    expect(card.getAttribute('aria-haspopup')).toBe('dialog');
    await click(card);
    expect(dialog()?.querySelector('[data-draft-source]')?.textContent).toContain('<p>PHONE</p>');
  });

  it('never happens on share links', async () => {
    await act(async () => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      root.render(
        <PublicArtifactsProvider artifacts={[]} markdownProps={{ skipHtml: true }}>
          <CreatedArtifactCards messageId="reply-1" />
        </PublicArtifactsProvider>,
      );
    });
    expect(document.querySelector('[data-artifact-panel]')).toBeNull();
    expect(document.querySelector('[data-artifact-announcer]')).toBeNull();
  });
});

describe('artifact tool call details', () => {
  async function renderSteps(message: UIMessage, streaming: boolean) {
    await mount([prompt, message], streaming);
  }
  const details = (name: string) => button(`Details: ${name}`);

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
    expect(container.textContent).toContain('Creating an artifact failed');
    await click(details('Creating an artifact failed'));
    expect(container.textContent).toContain('Too large.');
  });

  it('keep the JSON inputs view for other tools', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const search: UIMessage = reply({
      type: 'tool-web_search',
      toolCallId: 's1',
      state: 'output-available',
      input: { query: 'hours' },
      output: { query: 'hours', results: [] },
    } as never);
    await act(async () => root!.render(<ToolSteps message={search} />));
    await click(button("Searched the web for 'hours' · 0 results"));
    expect(container.textContent).toContain('"query": "hours"');
    expect(findButton('Details: hours')).toBeUndefined();
  });
});
