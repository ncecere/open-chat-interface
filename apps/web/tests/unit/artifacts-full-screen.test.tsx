// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { button, cleanup, click, dialog, findButton } from './admin-test-utils';
import {
  conversation,
  frames,
  fullScreenPanel,
  mockViewport,
  mountWithQueryClient,
  pressCancelableEscape,
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

describe('the panel in full screen', () => {
  it('fills the window as a modal dialog from the phone dialog, and Escape leaves it first', async () => {
    await mount(conversation());
    const card = button('Open artifact: Chart');
    card.focus();
    await click(card);
    expect(fullScreenPanel()).toBeNull();
    expect(dialog()?.className).toContain('md:w-[min(56rem,92vw)]');
    await click(button('Full screen'));
    const panel = fullScreenPanel()!;
    expect(panel).toBe(dialog());
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.className).toContain('inset-0');
    expect(panel.className).not.toContain('md:w-[min(56rem,92vw)]');
    // The toggle keeps focus, renamed; the preview is still there.
    expect(document.activeElement).toBe(button('Exit full screen'));
    expect(frames()).toHaveLength(1);

    await pressCancelableEscape();
    expect(fullScreenPanel()).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(button('Full screen'));
    await pressCancelableEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button('Open artifact: Chart'));
  });

  it('turns the docked panel into a modal dialog over everything, then back', async () => {
    mockViewport(1280);
    const container = await mount(conversation());
    const card = button('Open artifact: Chart');
    card.focus();
    await click(card);
    const panel = container.querySelector<HTMLElement>('aside[data-artifact-panel]')!;
    expect(panel.getAttribute('role')).toBeNull();
    await click(button('Full screen'));

    // The same element, now a labelled modal dialog filling the window.
    expect(container.querySelector('aside[data-artifact-panel]')).toBe(panel);
    expect(dialog()).toBe(panel);
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Chart',
    );
    expect(panel.className).toContain('fixed');
    expect(panel.className).toContain('inset-0');
    expect(panel.className).toContain('z-50');
    expect(panel.className).not.toContain('w-[45%]');
    expect(document.activeElement).toBe(button('Exit full screen'));
    // The conversation behind is inert; live regions are not; the layout keeps its width.
    const layout = container.querySelector<HTMLElement>('[data-artifacts-layout]')!;
    expect(layout.firstElementChild?.hasAttribute('inert')).toBe(true);
    expect(card.closest('[inert]')).not.toBeNull();
    expect(panel.closest('[inert]')).toBeNull();
    expect(layout.querySelector('[data-artifact-announcer]')?.hasAttribute('inert')).toBe(false);
    expect(layout.querySelector('[data-panel-placeholder]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );

    // Tab wraps around inside the panel: past either end it reaches a guard
    // that sends it round to the other end.
    const tabbable = [
      ...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), iframe, [tabindex="0"]:not([data-focus-guard])',
      ),
    ];
    expect(panel.firstElementChild?.getAttribute('data-focus-guard')).toBe('last');
    expect(panel.lastElementChild?.getAttribute('data-focus-guard')).toBe('first');
    await act(async () => (panel.lastElementChild as HTMLElement).focus());
    expect(document.activeElement).toBe(tabbable[0]);
    await act(async () => (panel.firstElementChild as HTMLElement).focus());
    expect(document.activeElement).toBe(tabbable.at(-1));
    expect(tabbable.at(-1)?.tagName).toBe('IFRAME');

    // Escape leaves full screen (focus back on the toggle), then closes.
    button('Exit full screen').focus();
    await pressCancelableEscape();
    expect(dialog()).toBeNull();
    expect(panel.getAttribute('role')).toBeNull();
    expect(panel.className).toContain('w-[45%]');
    expect(document.activeElement).toBe(button('Full screen'));
    expect(container.querySelector('[inert]')).toBeNull();
    expect(container.querySelector('[data-panel-placeholder]')).toBeNull();
    expect(panel.querySelector('[data-focus-guard]')).toBeNull();
    await pressCancelableEscape();
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(container.querySelector('aside[data-artifact-panel]')).toBeNull();
    expect(document.activeElement).toBe(button('Open artifact: Chart'));
  });

  it('leaves an edit, then full screen, then closes', async () => {
    await mount(conversation());
    await click(button('Open artifact: Plan'));
    await click(button('Full screen'));
    await click(button('Edit'));
    await pressCancelableEscape();
    expect(dialog()?.querySelector('textarea')).toBeNull();
    expect(fullScreenPanel()).not.toBeNull();
    await pressCancelableEscape();
    expect(fullScreenPanel()).toBeNull();
    expect(dialog()).not.toBeNull();
    await pressCancelableEscape();
    expect(dialog()).toBeNull();
  });

  it('ends when the panel closes or another artifact opens', async () => {
    mockViewport(1280);
    const container = await mount(conversation());
    await click(button('Open artifact: Chart'));
    await click(button('Full screen'));
    await click(button('Close'));
    expect(container.querySelector('[data-artifact-panel]')).toBeNull();
    expect(container.querySelector('[inert]')).toBeNull();
    await click(button('Open artifact: Chart'));
    expect(fullScreenPanel()).toBeNull();
    expect(findButton('Full screen')).toBeDefined();

    await click(button('Full screen'));
    expect(fullScreenPanel()).not.toBeNull();
    // (A script can still reach the card behind; a person cannot while it is inert.)
    await click(button('Open artifact: Plan'));
    const panel = container.querySelector<HTMLElement>('aside[data-artifact-panel]')!;
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Plan',
    );
    expect(fullScreenPanel()).toBeNull();
    expect(container.querySelector('[inert]')).toBeNull();
  });
});
