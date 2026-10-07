// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactFilename } from '../../src/components/artifacts/artifact-panel';
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
import {
  ARTIFACTS,
  conversation,
  frames,
  HTML,
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

  it('returns focus to Edit when the document editor closes (#333)', async () => {
    api.post.mockResolvedValue({ artifact: { ...ARTIFACTS[2], currentVersion: 3 } });
    // Browsers drop focus to the page when the focused element is removed;
    // happy-dom does not, so that is done here.
    const fixup = new MutationObserver(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !active.isConnected) (active as HTMLElement).blur();
    });
    fixup.observe(document.body, { childList: true, subtree: true });
    try {
      await mount(conversation());
      await click(button('Open artifact: Plan'));
      for (const leave of ['Escape', 'Cancel']) {
        button('Edit').focus();
        await click(button('Edit'));
        expect(document.activeElement).toBe(dialog()!.querySelector('textarea'));
        if (leave === 'Escape') await pressCancelableEscape();
        else await click(button('Cancel'));
        expect(dialog()?.querySelector('textarea')).toBeNull();
        expect(document.activeElement).toBe(button('Edit'));
      }
      // Save as new version: the button that had focus is gone with the editor.
      await click(button('Edit'));
      const editor = dialog()!.querySelector('textarea')!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!
          .set!;
        setter.call(editor, '# Plan v3');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settle();
      button('Save as new version').focus();
      await click(button('Save as new version'));
      expect(dialog()?.querySelector('textarea')).toBeNull();
      expect(document.activeElement).toBe(button('Edit'));
    } finally {
      fixup.disconnect();
    }
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
    // Full screen has its own column too, just before Close, outside the wrapping actions.
    const fullScreen = header.querySelector<HTMLElement>('[data-panel-fullscreen]')!;
    expect(fullScreen.parentElement).toBe(header);
    expect(close.previousElementSibling).toBe(fullScreen);
    expect(fullScreen.className).toContain('shrink-0');
    expect(fullScreen.className).not.toMatch(/\babsolute\b/);
    expect(toolbar.contains(fullScreen)).toBe(false);
    expect(fullScreen.getAttribute('aria-label')).toBe('Full screen');
    expect(header.children).toHaveLength(3);
    // Accessible names are unchanged.
    expect(findButton('Copy')).toBeDefined();
    expect(findButton('Download')).toBeDefined();
    expect(close.getAttribute('aria-label')).toBe('Close');
    await click(close);
    expect(dialog()).toBeNull();
  });

  it('keeps the same columns in full screen, with the toggle renamed', async () => {
    mockViewport(1280);
    await mount(conversation());
    await click(button('Open artifact: Plan'));
    await click(button('Full screen'));
    const header = dialog()!.querySelector<HTMLElement>('[data-panel-header]')!;
    const close = header.querySelector<HTMLElement>('[data-panel-close]')!;
    expect(header.lastElementChild).toBe(close);
    expect(close.previousElementSibling?.getAttribute('aria-label')).toBe('Exit full screen');
    expect(findButton('Full screen')).toBeUndefined();
  });
});
