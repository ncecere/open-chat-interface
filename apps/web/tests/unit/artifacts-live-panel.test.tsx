// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import type { ArtifactSummary } from '@oci/shared';
import type { UIMessage } from 'ai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicArtifactsProvider } from '../../src/components/artifacts/artifacts-provider';
import { CreatedArtifactCards } from '../../src/components/artifacts/reply-content';
import { button, cleanup, click, dialog, findButton } from './admin-test-utils';
import { mockViewport } from './artifacts.fixtures';
import {
  caughtUp,
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
const { mount, docked, announcer, composer, startLiveReply } = liveHarness({
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
