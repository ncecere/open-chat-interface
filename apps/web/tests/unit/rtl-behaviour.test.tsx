// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PANEL_KEY_STEP, widthForKey } from '../../src/components/artifacts/panel-resize';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../src/components/ui/dropdown-menu';
import { activateLocale } from '../../src/lib/i18n/state';
import { preloadCatalogs } from './i18n-test-utils';

// Behaviour that depends on the page's direction and is not a class: keys that
// mean "wider" or "next", and the direction Radix is told (it reads a prop, not
// the document).

beforeAll(preloadCatalogs);
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  await activateLocale('en');
});

describe('the docked panel separator', () => {
  it('widens with Left and narrows with Right in left-to-right (the panel is on the right)', () => {
    expect(widthForKey('ArrowLeft', false, 600, 2000)).toBe(600 + PANEL_KEY_STEP);
    expect(widthForKey('ArrowRight', false, 600, 2000)).toBe(600 - PANEL_KEY_STEP);
    expect(widthForKey('ArrowLeft', false, 600, 2000, false)).toBe(600 + PANEL_KEY_STEP);
  });

  it('is the other way round in right-to-left (the panel is on the left, its edge on the right)', () => {
    expect(widthForKey('ArrowRight', false, 600, 2000, true)).toBe(600 + PANEL_KEY_STEP);
    expect(widthForKey('ArrowLeft', false, 600, 2000, true)).toBe(600 - PANEL_KEY_STEP);
    expect(widthForKey('ArrowRight', true, 600, 2000, true)).toBe(600 + PANEL_KEY_STEP * 4);
    // Up, Down, Home and End do not depend on it.
    expect(widthForKey('ArrowUp', false, 600, 2000, true)).toBe(600 + PANEL_KEY_STEP);
    expect(widthForKey('ArrowDown', false, 600, 2000, true)).toBe(600 - PANEL_KEY_STEP);
  });
});

describe('menus', () => {
  async function open() {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>One</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    );
    return document.querySelector('[role="menu"]');
  }

  it('is told the page reads left to right in English', async () => {
    expect((await open())?.getAttribute('dir')).toBe('ltr');
  });

  it('is told the page reads right to left in Arabic, so a submenu opens with Left', async () => {
    await activateLocale('ar');
    expect((await open())?.getAttribute('dir')).toBe('rtl');
  });
});
