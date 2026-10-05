// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../../src/components/chat/model-picker';
import { ThemeProvider } from '../../src/providers/theme-provider';

type Props = ComponentProps<typeof ModelPicker>;
function model(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    id: 'alpha',
    slug: 'alpha',
    displayName: 'Alpha',
    description: 'Planning specialist',
    providerId: 'gateway',
    providerKind: 'openai-compatible',
    providerLabel: 'Local Gateway',
    upstreamModelId: 'alpha',
    capabilities: ['reasoning'],
    labId: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    supportedEfforts: [],
    isDefault: false,
    sortOrder: 0,
    ...overrides,
  };
}
const models = [
  model({}),
  model({
    id: 'beta',
    slug: 'beta',
    displayName: 'Beta',
    description: 'Image specialist',
    labId: 'anthropic',
    capabilities: ['vision'],
  }),
  model({
    id: 'gamma',
    slug: 'gamma',
    displayName: 'Gamma',
    description: 'Multimodal planner',
    capabilities: ['reasoning', 'vision'],
  }),
];
let container: HTMLDivElement;
let root: Root;
let props: Props;
let panelBounds: DOMRect;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  props = { models, selected: models[0]!, onSelect: vi.fn() };
  panelBounds = new DOMRect(100, 200, 400, 500);
  vi.stubGlobal('innerWidth', 1200);
  // happy-dom has no layout. Only the measured picker panel receives a synthetic
  // box; Radix and every UI component remain real. Advance one frame per action,
  // avoiding arbitrary sleeps and the controller's re-scheduled measurement loop.
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('aria-label') === 'Choose a model' ? panelBounds : original.call(this);
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function frame() {
  const pending = [...frames.values()];
  frames.clear();
  await act(() => {
    for (const callback of pending) callback(0);
  });
}
async function render(overrides: Partial<Props> = {}) {
  props = { ...props, ...overrides };
  await act(() =>
    root.render(
      <ThemeProvider>
        <ModelPicker {...props} />
      </ThemeProvider>,
    ),
  );
}
function button(label: string) {
  const result = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(result).not.toBeNull();
  return result!;
}
function textButton(text: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.trim().startsWith(text),
  );
  expect(result).toBeDefined();
  return result!;
}
async function click(node: HTMLElement) {
  await act(() => node.click());
  await frame();
}
function trigger() {
  return container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
}
async function open() {
  await click(trigger());
  expect(document.querySelector('[aria-label="Choose a model"]')).not.toBeNull();
}
function searchInput() {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
}
async function search(value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(() => {
    setValue.call(searchInput(), value);
    searchInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await frame();
}
function options() {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
}
function expectModels(names: string[]) {
  expect(options().map((option) => option.querySelector('.font-semibold')?.textContent)).toEqual(
    names,
  );
}
async function pressEscape() {
  await act(() => {
    searchInput().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await frame();
}
function detailsCard() {
  // Side-placement classes are the controller's observable geometry output; no
  // assertion about CSS layout/visibility is made in this non-layout environment.
  return document.querySelector<HTMLDivElement>(
    '[aria-label="Choose a model"] > .absolute.inset-y-0',
  );
}

describe('ModelPicker interaction', () => {
  it('renders an empty catalog without an interactive picker', async () => {
    await render({ models: [], selected: null });
    expect(container.textContent).toBe('No models available');
    expect(container.querySelector('button')).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('focuses search when opened and lets Escape close the real Radix popover', async () => {
    await render();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await open();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(searchInput());
    await pressEscape();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('filters by model name, description, provider and lab, including an empty result', async () => {
    await render();
    await open();
    for (const [query, names] of [
      ['  ALPHA  ', ['Alpha']],
      ['image specialist', ['Beta']],
      ['local gateway', ['Alpha', 'Beta', 'Gamma']],
      ['anthropic', ['Beta']],
      ['no-such-model', []],
    ] as const) {
      await search(query);
      expectModels([...names]);
    }
    expect(document.body.textContent).toContain('No models match that search.');
    await search('');
    expectModels(['Alpha', 'Beta', 'Gamma']);
  });

  it('toggles lab filtering, intersects search, and restores All labs', async () => {
    await render();
    await open();
    await click(button('OpenAI'));
    expect(button('OpenAI').getAttribute('aria-pressed')).toBe('true');
    expectModels(['Alpha', 'Gamma']);
    await search('gamma');
    expectModels(['Gamma']);
    await click(button('Anthropic'));
    expectModels([]);
    await search('');
    expectModels(['Beta']);
    await click(button('Anthropic'));
    expectModels(['Alpha', 'Beta', 'Gamma']);
    await click(button('OpenAI'));
    await click(button('All labs'));
    expect(button('All labs').getAttribute('aria-pressed')).toBe('true');
    expectModels(['Alpha', 'Beta', 'Gamma']);
  });

  it('supports any/all capability filtering, toggle-off and Clear', async () => {
    await render();
    await open();
    await click(button('Filter models'));
    const combine = textButton('Match every selected capability');
    expect(combine.disabled).toBe(true);
    await click(textButton('Reasoning'));
    expectModels(['Alpha', 'Gamma']);
    expect(combine.disabled).toBe(true);
    await click(textButton('Vision'));
    expect(combine.disabled).toBe(false);
    expectModels(['Alpha', 'Beta', 'Gamma']);
    await click(combine);
    expect(combine.getAttribute('aria-pressed')).toBe('true');
    expectModels(['Gamma']);
    await click(textButton('Vision'));
    expectModels(['Alpha', 'Gamma']);
    await click(textButton('Clear'));
    expectModels(['Alpha', 'Beta', 'Gamma']);
    expect(textButton('Reasoning').getAttribute('aria-pressed')).toBe('false');
    expect(combine.disabled).toBe(true);
  });

  it('preserves query and filters across Escape but closes transient filter/details panels', async () => {
    await render();
    await open();
    await search('planner');
    await click(button('OpenAI'));
    await click(button('Filter models'));
    await click(textButton('Reasoning'));
    await click(button('Details for Gamma'));
    expect(detailsCard()).not.toBeNull();
    await pressEscape();
    await open();
    expect(searchInput().value).toBe('planner');
    expect(button('OpenAI').getAttribute('aria-pressed')).toBe('true');
    expect(button('Filter models').getAttribute('aria-expanded')).toBe('false');
    expect(detailsCard()).toBeNull();
    expectModels(['Gamma']);
    await click(button('Filter models'));
    expect(textButton('Reasoning').getAttribute('aria-pressed')).toBe('true');
  });

  it('selects the original catalog object once with the latest callback and closes', async () => {
    await render();
    await open();
    const previous = props.onSelect;
    const onSelect = vi.fn();
    await render({ onSelect });
    await click(options()[1]!);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(models[1]);
    expect(onSelect.mock.calls[0]?.[0]).toBe(models[1]);
    expect(previous).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('keeps details beside the option, never nested in its button or selecting the model', async () => {
    await render();
    await open();
    const option = options()[0]!;
    const details = button('Details for Alpha');
    expect(option.tagName).toBe('BUTTON');
    expect(option.contains(details)).toBe(false);
    expect(details.parentElement?.closest('button')).toBeNull();
    expect(option.parentElement?.contains(details)).toBe(true);
    expect(document.querySelector('button button')).toBeNull();
    await click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(detailsCard()?.textContent).toContain('128K tokens');
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    ['right', 100, 1200, 'left-full'],
    ['left', 700, 1200, 'right-full'],
    ['no space', 100, 600, null],
  ] as const)(
    'places details with deterministic %s space',
    async (_, left, viewport, sideClass) => {
      panelBounds = new DOMRect(left, 200, 400, 500);
      vi.stubGlobal('innerWidth', viewport);
      await render();
      await open();
      if (sideClass === null) {
        expect(document.querySelector('[aria-label^="Details for "]')).toBeNull();
        expect(detailsCard()).toBeNull();
        expectModels(['Alpha', 'Beta', 'Gamma']);
      } else {
        await click(button('Details for Alpha'));
        expect(detailsCard()?.classList.contains(sideClass)).toBe(true);
        expect(detailsCard()?.textContent).toContain('Planning specialist');
      }
    },
  );

  it('toggles a single fixed details card and swaps its model without selecting', async () => {
    await render();
    await open();
    await click(button('Details for Alpha'));
    const card = detailsCard();
    await click(button('Details for Beta'));
    expect(detailsCard()).toBe(card);
    expect(card?.textContent).toContain('Image specialist');
    expect(card?.textContent).not.toContain('Planning specialist');
    expect(button('Details for Alpha').getAttribute('aria-expanded')).toBe('false');
    expect(button('Details for Beta').getAttribute('aria-expanded')).toBe('true');
    await click(button('Details for Beta'));
    expect(detailsCard()).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('hides details for a model removed by filtering', async () => {
    await render();
    await open();
    await click(button('Details for Alpha'));
    expect(detailsCard()).not.toBeNull();
    await search('beta');
    expectModels(['Beta']);
    expect(detailsCard()).toBeNull();
  });

  it('rechecks details availability on resize without relocating an already open card', async () => {
    await render();
    await open();
    await click(button('Details for Alpha'));
    expect(detailsCard()?.classList.contains('left-full')).toBe(true);
    panelBounds = new DOMRect(700, 200, 400, 500);
    await act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await frame();
    expect(detailsCard()?.classList.contains('left-full')).toBe(true);
    await click(button('Details for Alpha'));
    expect(detailsCard()).toBeNull();
    panelBounds = new DOMRect(100, 200, 400, 500);
    vi.stubGlobal('innerWidth', 600);
    await act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await frame();
    expect(document.querySelector('[aria-label^="Details for "]')).toBeNull();
  });

  it('omits a redundant single-lab rail and reflects controlled selection changes', async () => {
    await render({ models: [models[0]!, models[2]!], selected: null });
    expect(trigger().getAttribute('aria-label')).toBe('Select model. Current model: none');
    await open();
    expect(document.querySelector('fieldset')).toBeNull();
    expect(options().every((option) => option.getAttribute('aria-selected') === 'false')).toBe(
      true,
    );
    await render({ selected: models[2]! });
    expect(trigger().getAttribute('aria-label')).toBe('Select model. Current model: Gamma');
    expect(options().map((option) => option.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
    ]);
  });
});

describe('keyboard selection from the search box', () => {
  async function press(key: string) {
    await act(async () => {
      searchInput().dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
    });
  }

  it('picks the only match with Enter after typing a search', async () => {
    await render();
    await open();
    await search('beta');
    // The match is the active option, announced through the search box.
    expect(searchInput().getAttribute('aria-activedescendant')).toBe('model-option-beta');
    await press('Enter');
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'beta' }));
  });

  it('moves through the matches with the arrow keys, wrapping at the ends', async () => {
    await render();
    await open();
    // Starts on the current model.
    expect(searchInput().getAttribute('aria-activedescendant')).toBe('model-option-alpha');
    await press('ArrowDown');
    expect(searchInput().getAttribute('aria-activedescendant')).toBe('model-option-beta');
    await press('ArrowUp');
    await press('ArrowUp');
    expect(searchInput().getAttribute('aria-activedescendant')).toBe('model-option-gamma');
    await press('Enter');
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'gamma' }));
  });
});
