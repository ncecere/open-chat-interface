// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Select } from '../../src/components/ui/select';
import { ACCENTS, contrast, MODES, resolveColor, styleFor, tokens } from './css-test-utils';

/**
 * #239: a keyboard-focused Select trigger must be as visible as a focused
 * button or input: the 2 px accent outline, at 3:1 against the surfaces a
 * Select sits on (WCAG 2.4.7 and 1.4.11), in both themes and every accent.
 * Its only focus style was a 1 px border step of 1.2:1 against the unfocused
 * border, so on the Users page nobody could see which row's role select had
 * focus.
 *
 * The trigger is the real component; its classes are compiled by the
 * project's Tailwind and resolved against tokens.css.
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
});

/** Pages, settings panes, cards and dialogs: where Selects appear. */
const SURFACES = [
  '--bg-root',
  '--bg-root-alt',
  '--bg-app',
  '--bg-settings',
  '--bg-pill',
  '--bg-elevated',
] as const;

describe('keyboard focus on a Select trigger (#239)', () => {
  it('draws the 2 px accent ring, clear of every surface in every theme', async () => {
    await act(async () =>
      root.render(
        <Select
          aria-label="Role for h.sato@northbrook.edu"
          value="user"
          onChange={() => undefined}
          options={[
            { value: 'user', label: 'User' },
            { value: 'admin', label: 'Admin' },
          ]}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const idle = await styleFor(trigger.className);
    const focused = await styleFor(trigger.className, [':focus', ':focus-visible']);
    expect(focused['outline-style'], 'focus outline style').toBe('solid');
    expect(focused['outline-width'], 'focus outline width').toBe('2px');
    // Outside the border, as on buttons and inputs, so it sits on the surface.
    expect(focused['outline-offset'], 'focus outline offset').toBe('2px');
    const ring = focused['outline-color'];
    expect(ring, 'focus outline colour').toBeDefined();

    for (const mode of MODES) {
      for (const accent of ACCENTS) {
        const values = tokens(mode, accent);
        const ringColor = resolveColor(ring!, values);
        for (const surface of SURFACES) {
          expect(
            contrast(ringColor, resolveColor(`var(${surface})`, values)),
            `${mode} ${accent}: ring on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
        // The change from unfocused to focused is itself 3:1 or more.
        const idleBorder = resolveColor(idle['border-color']!, values);
        expect(
          contrast(ringColor, idleBorder),
          `${mode} ${accent}: ring against the unfocused border`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
