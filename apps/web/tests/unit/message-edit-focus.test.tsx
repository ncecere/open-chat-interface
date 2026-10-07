// @vitest-environment happy-dom
import type { UIMessage } from 'ai';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../src/components/chat/message-list';

/**
 * #333: Edit on a message swapped the message for an edit box and left focus
 * on the page: nothing was focused in the box, and Cancel, Escape and Save &
 * submit dropped it again. The real message list, row, actions and editor
 * run here; only the Markdown renderer and model list are stand-ins.
 * happy-dom keeps focus on a removed element, which browsers do not, so a
 * removal is emulated by blurring when the focused element leaves the page.
 */
vi.mock('../../src/components/chat/markdown', () => ({
  MARKDOWN_PROSE: '',
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('../../src/hooks/use-models', () => ({ useModels: () => ({ data: [] }) }));

let container: HTMLDivElement;
let root: Root;
let fixup: MutationObserver;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fixup = new MutationObserver(() => {
    const active = document.activeElement;
    if (active && active !== document.body && !active.isConnected) (active as HTMLElement).blur();
  });
  fixup.observe(container, { childList: true, subtree: true });
});
afterEach(async () => {
  fixup.disconnect();
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const question: UIMessage = {
  id: 'q',
  role: 'user',
  parts: [{ type: 'text', text: 'Hello there' }],
};
const answer: UIMessage = { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] };

async function render(onEdit: ComponentProps<typeof MessageList>['onEdit']) {
  await act(async () =>
    root.render(<MessageList messages={[question, answer]} streaming={false} onEdit={onEdit} />),
  );
}
const editButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label^="Edit message “"]')!;
const textBox = () => container.querySelector<HTMLTextAreaElement>('textarea')!;
const named = (label: string) =>
  [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)!;

/** Opens the editor the way a keyboard user does: focus the button, press it. */
async function openEditor() {
  editButton().focus();
  expect(document.activeElement).toBe(editButton());
  await act(async () => editButton().click());
}
async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

describe('editing a message keeps keyboard focus (#333)', () => {
  it('puts the cursor at the end of the text when Edit opens the box', async () => {
    await render(vi.fn(async () => {}));
    await openEditor();
    expect(document.activeElement).toBe(textBox());
    expect(textBox().selectionStart).toBe('Hello there'.length);
    expect(textBox().selectionEnd).toBe('Hello there'.length);
  });

  it('returns focus to Edit on Cancel', async () => {
    await render(vi.fn(async () => {}));
    await openEditor();
    named('Cancel').focus();
    await act(async () => named('Cancel').click());
    expect(container.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(editButton());
  });

  it('returns focus to Edit on Escape in the box', async () => {
    await render(vi.fn(async () => {}));
    await openEditor();
    await press(textBox(), 'Escape');
    expect(container.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(editButton());
  });

  it('cancels with Escape from a button in the box, too', async () => {
    await render(vi.fn(async () => {}));
    await openEditor();
    named('Cancel').focus();
    await press(named('Cancel'), 'Escape');
    expect(container.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(editButton());
  });

  it('returns focus to Edit after Save & submit when the conversation stays', async () => {
    const onEdit = vi.fn(async () => {});
    await render(onEdit);
    await openEditor();
    named('Save & submit').focus();
    await act(async () => named('Save & submit').click());
    expect(onEdit).toHaveBeenCalledWith('q', 'Hello there', []);
    expect(container.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(editButton());
  });

  it('keeps focus in the box while saving, and when saving fails', async () => {
    let fail = () => {};
    const onEdit = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = () => reject(new Error('Could not branch this message.'));
        }),
    );
    await render(onEdit);
    await openEditor();
    textBox().focus();
    await press(textBox(), 'Enter'); // plain Enter only adds a line
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => {
      textBox().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
    // Saving: the box is read-only, not disabled, so it still has focus.
    expect(textBox().readOnly).toBe(true);
    expect(document.activeElement).toBe(textBox());
    await act(async () => fail());
    expect(container.textContent).toContain('Could not branch this message.');
    expect(textBox().readOnly).toBe(false);
    expect(document.activeElement).toBe(textBox());
  });

  it('moves focus to the new conversation’s message box after an edit becomes a branch', async () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Message input');
    document.body.append(composer);
    await render(vi.fn(async () => {}));
    await openEditor();
    named('Save & submit').focus();
    await act(async () => named('Save & submit').click());
    // Focus is moved a frame later, once the page can take it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });
});
