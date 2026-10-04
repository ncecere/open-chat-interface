// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '../../src/components/chat/composer';
import { ThemeProvider } from '../../src/providers/theme-provider';

// The connect hint needs a query client and router; it has its own tests.
vi.mock('../../src/components/chat/composer-connect-hint', () => ({
  ComposerConnectHint: () => null,
}));

type Props = ComponentProps<typeof Composer>;
const model: CatalogModel = {
  id: 'reasoner',
  slug: 'reasoner',
  displayName: 'Test Reasoner',
  description: null,
  providerId: 'gateway',
  providerKind: 'openai-compatible',
  providerLabel: 'Gateway',
  upstreamModelId: 'reasoner',
  capabilities: ['reasoning'],
  labId: 'openai',
  contextWindow: null,
  maxOutputTokens: null,
  supportedEfforts: ['low', 'high'],
  isDefault: false,
  sortOrder: 0,
};

let container: HTMLDivElement;
let root: Root;
let props: Props;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  props = {
    value: 'Hello',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    models: [model],
    selectedModel: model,
    onSelectModel: vi.fn(),
    effort: 'low',
    onEffortChange: vi.fn(),
    webSearch: false,
    onWebSearchChange: vi.fn(),
    onAttachFiles: vi.fn(),
  };
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
async function render(overrides: Partial<Props> = {}) {
  props = { ...props, ...overrides };
  await act(() =>
    root.render(
      <ThemeProvider>
        <Composer {...props} />
      </ThemeProvider>,
    ),
  );
}
function textarea() {
  return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message input"]')!;
}
function button(label: string) {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(result).not.toBeNull();
  return result!;
}
async function enter(init: KeyboardEventInit = {}, keyCode?: number) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  // Safari can end composition before Enter while retaining legacy keyCode 229.
  if (keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: keyCode });
  await act(() => {
    textarea().dispatchEvent(event);
  });
  return event;
}

describe('Composer interaction', () => {
  it('submits normal Enter exactly once and prevents a newline', async () => {
    await render();
    const event = await enter();
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith();
    expect(event.defaultPrevented).toBe(true);
  });

  it('sends once for a held Enter: auto-repeat neither sends nor adds lines', async () => {
    await render();
    await enter();
    for (let repeat = 0; repeat < 20; repeat += 1) {
      const event = await enter({ repeat: true });
      expect(event.defaultPrevented).toBe(true);
    }
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it('gates Send and Enter while a submission is in flight, without showing Stop', async () => {
    await render({ submitting: true });
    expect(button('Send message').disabled).toBe(true);
    expect(button('Send message').getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[aria-label="Stop generating"]')).toBeNull();
    await act(() => button('Send message').click());
    const event = await enter();
    expect(event.defaultPrevented).toBe(true);
    expect(props.onSubmit).not.toHaveBeenCalled();
    await render({ submitting: false });
    expect(button('Send message').disabled).toBe(false);
    expect(button('Send message').hasAttribute('aria-busy')).toBe(false);
  });

  it('leaves Shift+Enter available for a newline', async () => {
    await render();
    const event = await enter({ shiftKey: true });
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not submit or preventDefault for Enter during IME composition', async () => {
    await render();
    const event = await enter({ isComposing: true });
    expect(event.isComposing).toBe(true);
    expect.soft(props.onSubmit).not.toHaveBeenCalled();
    expect.soft(event.defaultPrevented).toBe(false);
  });

  it('does not submit or preventDefault for Safari IME Enter with keyCode 229', async () => {
    await render();
    const event = await enter({ isComposing: false }, 229);
    expect(event.isComposing).toBe(false);
    expect(event.keyCode).toBe(229);
    expect.soft(props.onSubmit).not.toHaveBeenCalled();
    expect.soft(event.defaultPrevented).toBe(false);
  });

  it.each([
    ['whitespace', { value: ' \n\t ' }],
    ['no selected model', { selectedModel: null }],
    [
      'upload in progress',
      {
        attachments: [
          {
            localId: 'upload',
            filename: 'notes.txt',
            sizeBytes: 4,
            mimeType: 'text/plain',
            status: 'uploading',
          },
        ],
      },
    ],
  ] satisfies [string, Partial<Props>][])(
    'gates both submission paths with %s',
    async (_, overrides) => {
      await render(overrides);
      expect(button('Send message').disabled).toBe(true);
      await act(() => button('Send message').click());
      await enter();
      expect(props.onSubmit).not.toHaveBeenCalled();
    },
  );

  it('gates Enter while streaming and routes Stop only to onStop', async () => {
    await render({ streaming: true });
    expect(container.querySelector('[aria-label="Send message"]')).toBeNull();
    await enter();
    await act(() => button('Stop generating').click());
    expect(props.onStop).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('draws the Stop and Send icons in the accent foreground, never the page text colour', async () => {
    // On the neutral theme the accent is the page text colour, which hid the icons.
    await render({ streaming: true });
    expect(button('Stop generating').className).toContain('text-[var(--accent-button-foreground)]');
    await render({ streaming: false, value: 'Hello' });
    expect(button('Send message').className).toContain('text-[var(--accent-button-foreground)]');
    expect(button('Send message').className).not.toContain('text-[var(--text-primary)]');
  });

  it('focuses the message field on mount only when asked', async () => {
    await render();
    expect(document.activeElement).not.toBe(textarea());
    await act(() => root.unmount());
    root = createRoot(container);
    await render({ autoFocus: true });
    expect(document.activeElement).toBe(textarea());
  });

  it('marks focus inside the composer border, with nothing drawn outside it', async () => {
    await render();
    const box = container.querySelector('textarea')?.parentElement;
    expect(box?.className).toContain('focus-within:-outline-offset-1');
    expect(box?.className).not.toContain('focus-within:outline-offset-2');
  });

  it('enables Send after an upload completes and uses the latest callback', async () => {
    const item = {
      localId: 'upload',
      filename: 'notes.txt',
      sizeBytes: 4,
      mimeType: 'text/plain',
      status: 'uploading' as const,
    };
    await render({ attachments: [item] });
    const oldSubmit = props.onSubmit;
    const onSubmit = vi.fn();
    await render({ attachments: [{ ...item, status: 'ready' }], onSubmit });
    expect(button('Send message').disabled).toBe(false);
    await act(() => button('Send message').click());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(oldSubmit).not.toHaveBeenCalled();
  });

  it('forwards textarea input without submitting and renders the controlled value', async () => {
    await render({ placeholder: 'Ask anything' });
    expect(textarea().placeholder).toBe('Ask anything');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(() => {
      setValue.call(textarea(), 'Revised message');
      textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith('Revised message');
    expect(props.onSubmit).not.toHaveBeenCalled();
    await render({ value: 'Revised message' });
    expect(textarea().value).toBe('Revised message');
  });

  it('remeasures at auto height on text changes, clamps to 220px, then shrinks', async () => {
    let measuredHeight = 44;
    const heightsAtMeasurement: string[] = [];
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      heightsAtMeasurement.push(this.style.height);
      return measuredHeight;
    });
    await render();
    expect(textarea().style.height).toBe('44px');
    measuredHeight = 360;
    await render({ value: 'A long multiline message' });
    expect(textarea().style.height).toBe('220px');
    measuredHeight = 28;
    await render({ value: '' });
    expect(textarea().style.height).toBe('28px');
    expect(heightsAtMeasurement).toEqual(['auto', 'auto', 'auto']);
  });

  it('toggles provider-independent search only when available', async () => {
    await render({ selectedModel: { ...model, capabilities: [] } });
    expect(button('Search').disabled).toBe(false);
    await act(() => button('Search').click());
    expect(props.onWebSearchChange).toHaveBeenLastCalledWith(true);
    await render({ webSearch: true });
    await act(() => button('Search').click());
    expect(props.onWebSearchChange).toHaveBeenLastCalledWith(false);
    await render({ webSearchAvailable: false });
    expect(button('Search').disabled).toBe(true);
    await act(() => button('Search').click());
    expect(props.onWebSearchChange).toHaveBeenCalledTimes(2);
  });

  it('only opens the file input when attachments and their callback are available', async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const open = vi.spyOn(input, 'click').mockImplementation(() => {});
    expect(input.multiple).toBe(true);
    await act(() => button('Attach').click());
    expect(open).toHaveBeenCalledOnce();
    await render({ attachmentsAvailable: false });
    expect(button('Attach').disabled).toBe(true);
    await act(() => button('Attach').click());
    await render({ attachmentsAvailable: true, onAttachFiles: undefined });
    expect(button('Attach').disabled).toBe(true);
    await act(() => button('Attach').click());
    expect(open).toHaveBeenCalledOnce();
  });

  it('resets the file input after each selection so the same file can be selected again', async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    // A native file chooser cannot run in happy-dom. Supply its observable files/value;
    // exercise the real change handler and require an actual reset on every selection.
    let chooserValue = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => chooserValue,
      set: (value: string) => {
        chooserValue = value;
      },
    });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    for (let selection = 0; selection < 2; selection++) {
      chooserValue = 'C:\\fakepath\\notes.txt';
      await act(() => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(chooserValue).toBe('');
    }
    expect(props.onAttachFiles).toHaveBeenCalledTimes(2);
    expect(props.onAttachFiles).toHaveBeenNthCalledWith(1, [file]);
    expect(props.onAttachFiles).toHaveBeenNthCalledWith(2, [file]);
    Object.defineProperty(input, 'files', { configurable: true, value: [] });
    await act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(props.onAttachFiles).toHaveBeenCalledTimes(2);
  });

  it('updates reasoning availability on the actual button trigger', async () => {
    await render();
    expect(button('low').disabled).toBe(false);
    expect(button('low').getAttribute('aria-haspopup')).toBe('menu');
    await render({ selectedModel: { ...model, capabilities: [], supportedEfforts: [] } });
    expect(button('low').disabled).toBe(true);
    await render({ selectedModel: null });
    expect(button('low').disabled).toBe(true);
  });
});
