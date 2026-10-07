// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../../src/components/chat/model-picker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../src/components/ui/dropdown-menu';
import { Select } from '../../src/components/ui/select';
import { ThemeProvider } from '../../src/providers/theme-provider';
import {
  ACCENTS,
  contrast,
  type ElementState,
  MODES,
  resolveColor,
  styleFor,
  tokens,
} from './css-test-utils';

/**
 * #135: the keyboard-focused item of a menu, a Select popup or the model
 * picker must be visibly marked, at 3:1 against what surrounds it (WCAG
 * 2.4.7 and 1.4.11), in both themes and every accent.
 *
 * The components are real Radix, driven by the keyboard. Their classes are
 * compiled by the project's Tailwind and resolved against tokens.css, so the
 * check is on the colours that reach the screen.
 */

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function press(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** The states an element is in, for applying Tailwind's variants to it. */
function statesOf(element: Element, { focused }: { focused: boolean }): ElementState[] {
  const states: ElementState[] = [];
  if (focused) states.push(':focus', ':focus-visible');
  for (const { name, value } of element.attributes) {
    if (!name.startsWith('data-') && !name.startsWith('aria-')) continue;
    states.push(`[${name}]`, `[${name}="${value}"]`);
  }
  return states;
}

/** What the marked item looks like on screen, checked in every theme. */
async function expectVisibleMark(element: Element, { focused }: { focused: boolean }) {
  const style = await styleFor(element.className, statesOf(element, { focused }));
  expect(style['outline-style'], 'focus outline style').toBe('solid');
  expect(style['outline-width'], 'focus outline width').toBe('2px');
  const ring = style['outline-color'];
  expect(ring, 'focus outline colour').toBeDefined();

  for (const mode of MODES) {
    for (const accent of ACCENTS) {
      const values = tokens(mode, accent);
      const ringColor = resolveColor(ring!, values);
      const surface = resolveColor('var(--bg-elevated)', values);
      const fill = resolveColor(style['background-color'] ?? 'var(--bg-elevated)', values);
      expect(
        contrast(ringColor, surface),
        `${mode} ${accent}: ring on menu`,
      ).toBeGreaterThanOrEqual(3);
      expect(contrast(ringColor, fill), `${mode} ${accent}: ring on item`).toBeGreaterThanOrEqual(
        3,
      );
    }
  }
}

describe('keyboard focus on a list item (#135)', () => {
  it('rings the focused dropdown menu item', async () => {
    await act(async () =>
      root.render(
        <DropdownMenu>
          <DropdownMenuTrigger>Appearance settings</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Settings</DropdownMenuItem>
            <DropdownMenuRadioGroup value="dark">
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    );
    const trigger = container.querySelector('button')!;
    trigger.focus();
    await press(trigger, 'Enter');
    expect(document.activeElement?.textContent).toBe('Settings');
    await expectVisibleMark(document.activeElement!, { focused: true });

    // happy-dom has no layout for Radix's arrow-key navigation, so focus the
    // next item as ArrowDown does; Radix highlights whatever item has focus.
    const system = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')][0]!;
    await act(async () => system.focus());
    expect(document.activeElement).toBe(system);
    expect(system.hasAttribute('data-highlighted')).toBe(true);
    await expectVisibleMark(document.activeElement!, { focused: true });
  });

  it('rings the focused Select option', async () => {
    // Radix Select reads pointer capture and scrolls items into view.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.scrollIntoView ??= () => undefined;
    await act(async () =>
      root.render(
        <Select
          aria-label="Role"
          value="user"
          onChange={() => undefined}
          options={[
            { value: 'user', label: 'User' },
            { value: 'admin', label: 'Admin' },
          ]}
        />,
      ),
    );
    const trigger = container.querySelector('button')!;
    trigger.focus();
    await press(trigger, 'Enter');
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const focused = document.activeElement!;
    expect(focused.getAttribute('role')).toBe('option');
    await expectVisibleMark(focused, { focused: true });
  });

  it("rings the model picker's active option", async () => {
    const model = (id: string): CatalogModel => ({
      id,
      slug: id,
      displayName: id,
      description: null,
      providerId: 'gateway',
      providerKind: 'openai-compatible',
      providerLabel: 'Gateway',
      upstreamModelId: id,
      capabilities: [],
      labId: 'openai',
      contextWindow: 1000,
      maxOutputTokens: 100,
      supportedEfforts: [],
      isDefault: false,
      sortOrder: 0,
    });
    const models = [model('alpha'), model('beta')];
    await act(async () =>
      root.render(
        <ThemeProvider>
          <ModelPicker models={models} selected={models[0]!} onSelect={() => undefined} />
        </ThemeProvider>,
      ),
    );
    await act(async () => container.querySelector('button')!.click());
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    await press(search, 'ArrowDown');
    const option = document.getElementById(search.getAttribute('aria-activedescendant')!)!;
    expect(option.textContent).toContain('beta');
    // The ring is on the option's row; focus itself stays in the search box.
    await expectVisibleMark(option.parentElement!, { focused: false });
  });
});
