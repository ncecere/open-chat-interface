// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelPicker } from '../../src/components/chat/model-picker';
import { ThemeProvider } from '../../src/providers/theme-provider';
import { styleFor } from './css-test-utils';

/**
 * #169 (regression of #70): on a 390 px phone the model picker ran from x=16
 * to the right edge. Real Radix positioning (Floating UI); happy-dom has no
 * layout, so the window, the trigger's box and the panel's width (its
 * compiled CSS at this width) are given.
 */
const WINDOW = 390;
const model = (id: string): CatalogModel =>
  ({
    id,
    slug: id,
    displayName: id,
    description: null,
    providerId: 'p',
    providerKind: 'openai-compatible',
    providerLabel: 'P',
    upstreamModelId: id,
    capabilities: [],
    labId: 'openai',
    contextWindow: null,
    maxOutputTokens: null,
    supportedEfforts: [],
    isDefault: false,
    sortOrder: 0,
  }) as CatalogModel;

/** `min(29rem, calc(100vw - Nrem))` at the test window, in px. */
function panelWidth(width: string): number {
  const match = width.match(/^min\(29rem,\s*calc\(100vw - ([\d.]+)rem\)\)$/);
  if (!match) throw new Error(`Unexpected width ${width}`);
  return Math.min(29 * 16, WINDOW - Number(match[1]) * 16);
}

let root: Root;
let container: HTMLDivElement;
let width = 0;
let triggerX = 16;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('innerWidth', WINDOW);
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('visualViewport', {
    width: WINDOW,
    height: 844,
    offsetLeft: 0,
    offsetTop: 0,
    scale: 1,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(WINDOW);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(844);
  // The panel and Radix's positioned wrapper around it, which Floating UI measures.
  const panel = (element: Element) =>
    element.getAttribute('aria-label') === 'Choose a model' ||
    element.hasAttribute('data-radix-popper-content-wrapper');
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('role') === 'combobox' && this.tagName === 'BUTTON')
      return new DOMRect(triggerX, 700, 140, 32);
    if (panel(this)) return new DOMRect(0, 0, width, 480);
    return rect.call(this);
  });
  for (const property of ['offsetWidth', 'clientWidth'] as const)
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return panel(this) ? width : 0;
    });
  for (const property of ['offsetHeight', 'clientHeight'] as const)
    vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return panel(this) ? 480 : 0;
    });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([16, 60])(
  'keeps the 16 px page margin on both sides of a phone (picker at x=%i)',
  async (x0) => {
    triggerX = x0;
    const models = [model('alpha'), model('beta')];
    await act(async () =>
      root.render(
        <ThemeProvider>
          <ModelPicker models={models} selected={models[0]!} onSelect={() => undefined} />
        </ThemeProvider>,
      ),
    );
    const panel = () => document.querySelector<HTMLElement>('[aria-label="Choose a model"]');
    await act(async () => container.querySelector('button')!.click());
    width = panelWidth((await styleFor(panel()!.className)).width!);
    // Let Floating UI measure again with the panel's width.
    await act(async () => window.dispatchEvent(new Event('resize')));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    const wrapper = panel()!.closest<HTMLElement>('[data-radix-popper-content-wrapper]')!;
    const x = Number(wrapper.style.transform.match(/translate\((-?[\d.]+)px/)?.[1]);
    expect(Number.isFinite(x)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(16);
    expect(WINDOW - (x + width)).toBeGreaterThanOrEqual(16);
  },
);
