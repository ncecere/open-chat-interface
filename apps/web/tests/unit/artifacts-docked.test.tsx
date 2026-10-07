// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicArtifactsProvider } from '../../src/components/artifacts/artifacts-provider';
import {
  clampPanelWidth,
  maxPanelWidth,
  PANEL_KEY_STEP,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  widthForKey,
} from '../../src/components/artifacts/panel-resize';
import { CreatedArtifactCards } from '../../src/components/artifacts/reply-content';
import { button, cleanup, click, dialog } from './admin-test-utils';
import {
  conversation,
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

    // Full screen works here too, and ends with the panel.
    await click(button('Full screen'));
    expect(fullScreenPanel()).toBe(dialog());
    expect(document.activeElement).toBe(button('Exit full screen'));
    await pressCancelableEscape();
    expect(fullScreenPanel()).toBeNull();
    expect(document.activeElement).toBe(button('Full screen'));
    await click(button('Full screen'));
    await click(button('Close'));
    expect(dialog()).toBeNull();
    await click(button('Open artifact: Plan'));
    expect(fullScreenPanel()).toBeNull();
  });
});

describe('resizing the docked panel', () => {
  const separator = () => document.querySelector<HTMLElement>('[role="separator"]');
  const panel = () => document.querySelector<HTMLElement>('aside[data-artifact-panel]')!;
  const key = async (target: HTMLElement, name: string, shiftKey = false) => {
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }),
      );
    });
  };

  it('clamps to 22rem and 70% of the window, and maps keys to widths', () => {
    expect(maxPanelWidth(2000)).toBe(1400);
    expect(maxPanelWidth(400)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(100, 2000)).toBe(PANEL_MIN_WIDTH);
    expect(clampPanelWidth(5000, 2000)).toBe(1400);
    expect(clampPanelWidth(600.4, 2000)).toBe(600);
    // The separator is the left edge: Left widens, Right narrows.
    expect(widthForKey('ArrowLeft', false, 600, 2000)).toBe(600 + PANEL_KEY_STEP);
    expect(widthForKey('ArrowRight', false, 600, 2000)).toBe(600 - PANEL_KEY_STEP);
    expect(widthForKey('ArrowLeft', true, 600, 2000)).toBe(600 + 4 * PANEL_KEY_STEP);
    expect(widthForKey('ArrowRight', false, PANEL_MIN_WIDTH, 2000)).toBe(PANEL_MIN_WIDTH);
    expect(widthForKey('Home', false, 600, 2000)).toBe(PANEL_MIN_WIDTH);
    expect(widthForKey('End', false, 600, 2000)).toBe(1400);
    expect(widthForKey('a', false, 600, 2000)).toBeNull();
  });

  it('has a keyboard-operable separator whose width is remembered, and Enter resets it', async () => {
    mockViewport(1280);
    await mount(conversation());
    await click(button('Open artifact: Chart'));
    const handle = separator()!;
    expect(handle).not.toBeNull();
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('Resize artifact panel');
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-controls')).toBe(panel().id);
    expect(Number(handle.getAttribute('aria-valuemin'))).toBe(PANEL_MIN_WIDTH);
    const max = maxPanelWidth(window.innerWidth);
    expect(Number(handle.getAttribute('aria-valuemax'))).toBe(max);
    // Until resized, the responsive default stays in CSS.
    expect(panel().className).toContain('w-[45%]');
    expect(panel().style.width).toBe('');

    handle.focus();
    await key(handle, 'Home');
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANEL_MIN_WIDTH));
    expect(panel().style.width).toBe(`${PANEL_MIN_WIDTH}px`);
    expect(panel().className).not.toContain('w-[45%]');
    expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe(String(PANEL_MIN_WIDTH));
    await key(handle, 'ArrowLeft');
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANEL_MIN_WIDTH + PANEL_KEY_STEP));
    await key(handle, 'ArrowRight');
    expect(handle.getAttribute('aria-valuenow')).toBe(String(PANEL_MIN_WIDTH));
    await key(handle, 'End');
    expect(handle.getAttribute('aria-valuenow')).toBe(String(max));
    expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe(String(max));
    // Focus stays on the separator; Escape there still closes the panel.
    expect(document.activeElement).toBe(handle);

    // Closed and opened again (or after a reload), the width is remembered.
    await click(button('Close'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    await click(button('Open artifact: Chart'));
    expect(panel().style.width).toBe(`${max}px`);

    // Enter restores the default and forgets the width.
    await key(separator()!, 'Enter');
    expect(panel().className).toContain('w-[45%]');
    expect(panel().style.width).toBe('');
    expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBeNull();
  });

  it('follows a drag from its left edge, and a double click resets it', async () => {
    mockViewport(1280);
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, '500');
    await mount(conversation());
    await click(button('Open artifact: Chart'));
    const handle = separator()!;
    expect(panel().style.width).toBe('500px');
    const pointer = (type: string, clientX: number) =>
      act(async () => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        handle.dispatchEvent(event);
      });
    await pointer('pointerdown', 600);
    await pointer('pointermove', 560);
    // Moving left by 40px widens the panel by 40px, stored when the drag ends.
    expect(panel().style.width).toBe('540px');
    expect(handle.hasAttribute('data-dragging')).toBe(true);
    expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe('500');
    await pointer('pointermove', 2000);
    expect(panel().style.width).toBe(`${PANEL_MIN_WIDTH}px`);
    await pointer('pointermove', 520);
    await pointer('pointerup', 520);
    expect(panel().style.width).toBe('580px');
    expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBe('580');
    expect(handle.hasAttribute('data-dragging')).toBe(false);
    // Moving the pointer without a drag changes nothing.
    await pointer('pointermove', 100);
    expect(panel().style.width).toBe('580px');

    await act(async () => {
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(panel().style.width).toBe('');
    expect(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY)).toBeNull();
  });

  it('is absent in full screen and in the phone dialog', async () => {
    mockViewport(1280);
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, '500');
    await mount(conversation());
    await click(button('Open artifact: Chart'));
    expect(separator()).not.toBeNull();
    await click(button('Full screen'));
    expect(separator()).toBeNull();
    expect(panel().style.width).toBe('');
    expect(document.querySelector<HTMLElement>('[data-panel-placeholder]')?.style.width).toBe(
      '500px',
    );
    await click(button('Exit full screen'));
    expect(separator()).not.toBeNull();
    await click(button('Close'));

    await cleanup(root!);
    root = undefined;
    mockViewport(390);
    await mount(conversation());
    await click(button('Open artifact: Chart'));
    expect(dialog()).not.toBeNull();
    expect(separator()).toBeNull();
  });
});
