// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/chat/composer';
import { MessageEditor } from '../../src/components/chat/message-editor';
import { isSendKey } from '../../src/lib/send-keys';
import { ThemeProvider, useTheme } from '../../src/providers/theme-provider';

/**
 * "Invert Send/New Line Behavior" (Settings → Customization, v0.9.1): kept
 * per browser, and honoured by the composer and the message editor.
 */
vi.mock('../../src/components/chat/composer-connect-hint', () => ({
  ComposerConnectHint: () => null,
}));

const model = {
  id: 'm',
  slug: 'm',
  displayName: 'Model',
  description: null,
  providerId: 'p',
  providerKind: 'openai-compatible',
  providerLabel: 'P',
  upstreamModelId: 'm',
  capabilities: [],
  labId: 'openai',
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: [],
  isDefault: true,
  sortOrder: 0,
} as unknown as CatalogModel;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

async function press(target: Element, init: KeyboardEventInit = {}, keyCode?: number) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  await act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('isSendKey', () => {
  const key = (init: Partial<Parameters<typeof isSendKey>[0]> = {}) => ({
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: {},
    ...init,
  });

  it('sends on Enter and not Shift+Enter by default', () => {
    expect(isSendKey(key(), { invert: false })).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), { invert: false })).toBe(false);
    expect(isSendKey(key({ key: 'a' }), { invert: false })).toBe(false);
  });

  it('sends only on Cmd/Ctrl+Enter when inverted', () => {
    expect(isSendKey(key(), { invert: true })).toBe(false);
    expect(isSendKey(key({ shiftKey: true }), { invert: true })).toBe(false);
    expect(isSendKey(key({ metaKey: true }), { invert: true })).toBe(true);
    expect(isSendKey(key({ ctrlKey: true }), { invert: true })).toBe(true);
  });

  it('never sends while an input method is composing', () => {
    for (const invert of [false, true]) {
      expect(
        isSendKey(key({ metaKey: true, nativeEvent: { isComposing: true } }), { invert }),
      ).toBe(false);
      expect(isSendKey(key({ ctrlKey: true, nativeEvent: { keyCode: 229 } }), { invert })).toBe(
        false,
      );
    }
  });
});

describe('the composer', () => {
  async function render(onSubmit = vi.fn()) {
    await act(() =>
      root.render(
        <ThemeProvider>
          <Composer
            value="Hello"
            onChange={vi.fn()}
            onSubmit={onSubmit}
            models={[model]}
            selectedModel={model}
            onSelectModel={vi.fn()}
            effort="instant"
            onEffortChange={vi.fn()}
            webSearch={false}
            onWebSearchChange={vi.fn()}
            onAttachFiles={vi.fn()}
          />
        </ThemeProvider>,
      ),
    );
    return {
      onSubmit,
      textarea: container.querySelector('textarea[aria-label="Message input"]')!,
      send: container.querySelector('button[aria-label="Send message"]')!,
    };
  }

  it('keeps Enter to send when the setting is off, and says so to assistive tech', async () => {
    const { onSubmit, textarea, send } = await render();
    expect(send.getAttribute('aria-keyshortcuts')).toBe('Enter');
    await press(textarea);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('adds a line on Enter and sends on Cmd/Ctrl+Enter when inverted', async () => {
    localStorage.setItem('oci.invertSend', 'true');
    const { onSubmit, textarea, send } = await render();
    expect(send.getAttribute('aria-keyshortcuts')).toBe('Meta+Enter Control+Enter');

    const plain = await press(textarea);
    const shifted = await press(textarea, { shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    // Not prevented: the textarea inserts the new line itself.
    expect(plain.defaultPrevented).toBe(false);
    expect(shifted.defaultPrevented).toBe(false);

    const composing = await press(textarea, { metaKey: true }, 229);
    expect(composing.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    await press(textarea, { metaKey: true });
    await press(textarea, { ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

describe('the message editor', () => {
  async function render() {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    await act(() =>
      root.render(
        <ThemeProvider>
          <MessageEditor messageId="m1" initialText="Draft" onEdit={onEdit} onClose={vi.fn()} />
        </ThemeProvider>,
      ),
    );
    return { onEdit, textarea: container.querySelector('textarea')! };
  }

  it.each([
    ['off', 'false'],
    ['on', 'true'],
  ])('adds lines on Enter and submits on Cmd/Ctrl+Enter with the setting %s', async (_, stored) => {
    localStorage.setItem('oci.invertSend', stored);
    const { onEdit, textarea } = await render();
    expect((await press(textarea)).defaultPrevented).toBe(false);
    await press(textarea, { ctrlKey: true }, 229);
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onEdit).toHaveBeenCalledWith('m1', 'Draft', []);
  });
});

describe('the stored choice', () => {
  it('is saved per browser and read back by a new provider', async () => {
    let api: ReturnType<typeof useTheme> | undefined;
    function Probe() {
      api = useTheme();
      return null;
    }
    await act(() =>
      root.render(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      ),
    );
    expect(api?.invertSend).toBe(false);
    await act(() => api?.setInvertSend(true));
    expect(localStorage.getItem('oci.invertSend')).toBe('true');
    expect(api?.invertSend).toBe(true);
  });
});
