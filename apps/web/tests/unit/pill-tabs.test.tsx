// @vitest-environment happy-dom
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PillTabs } from '../../src/components/ui/pill-tabs';
import { cleanup, renderAdmin } from './admin-test-utils';
import { styleFor, toPx } from './css-test-utils';

let root: Root | undefined;
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const TABS = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
  { id: 'three', label: 'Three' },
] as const;

function Harness() {
  const [active, setActive] = useState<(typeof TABS)[number]['id']>('one');
  return (
    <>
      <PillTabs tabs={TABS} active={active} onChange={setActive} label="Facets" />
      <output>{active}</output>
    </>
  );
}

const tab = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => element.textContent === name,
  ) as HTMLButtonElement;
const selected = () => document.querySelector('output')?.textContent;

async function press(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

it('keeps only the selected tab in the Tab order', async () => {
  ({ root } = await renderAdmin(<Harness />));
  expect(tab('One').tabIndex).toBe(0);
  expect(tab('Two').tabIndex).toBe(-1);
  expect(tab('Three').tabIndex).toBe(-1);
});

it('moves focus and selection with arrow keys, wrapping at the ends', async () => {
  ({ root } = await renderAdmin(<Harness />));
  await press(tab('One'), 'ArrowRight');
  expect(selected()).toBe('two');
  expect(document.activeElement).toBe(tab('Two'));
  expect(tab('Two').tabIndex).toBe(0);

  await press(tab('Two'), 'ArrowRight');
  await press(tab('Three'), 'ArrowRight');
  expect(selected()).toBe('one');
  expect(document.activeElement).toBe(tab('One'));

  await press(tab('One'), 'ArrowLeft');
  expect(selected()).toBe('three');
});

it('jumps to the first and last tab with Home and End', async () => {
  ({ root } = await renderAdmin(<Harness />));
  await press(tab('One'), 'End');
  expect(selected()).toBe('three');
  await press(tab('Three'), 'Home');
  expect(selected()).toBe('one');
  expect(document.activeElement).toBe(tab('One'));
});

it('ignores other keys', async () => {
  ({ root } = await renderAdmin(<Harness />));
  await press(tab('One'), 'a');
  expect(selected()).toBe('one');
});

/**
 * #243: a project's four tabs ran 12 px past a 390 px phone's 358 px of
 * content, and the strip's hidden scrollbar gave no sign there was more.
 */
describe('on a phone (#243)', () => {
  const PROJECT_TABS = [
    { id: 'conversations', label: 'Conversations' },
    { id: 'instructions', label: 'Instructions' },
    { id: 'files', label: 'Files' },
    { id: 'settings', label: 'Settings' },
  ] as const;

  it("fits a project's four tabs in the width a 390 px phone leaves", async () => {
    ({ root } = await renderAdmin(
      <PillTabs tabs={PROJECT_TABS} active="files" onChange={() => undefined} label="Project" />,
    ));
    const strip = document.querySelector<HTMLElement>('[role="tablist"]')!;
    // Phone width: no `sm:` rule applies (styleFor reads unconditional rules).
    const outer = await styleFor(strip.className);
    let width = 2 * toPx(outer.padding) + (PROJECT_TABS.length - 1) * toPx(outer.gap);
    for (const element of strip.querySelectorAll('[role="tab"]')) {
      width += 2 * toPx((await styleFor(element.className))['padding-inline']);
    }
    // The four labels' text in the app's font at 14 px, measured in Chrome
    // during the walk (scrollWidth 370 less the padding and gaps then).
    width += 254;
    expect(width).toBeLessThanOrEqual(390 - 2 * 16);
  });

  it('fades the side with tabs out of view', async () => {
    ({ root } = await renderAdmin(
      <PillTabs tabs={PROJECT_TABS} active="files" onChange={() => undefined} label="Project" />,
    ));
    const strip = document.querySelector<HTMLElement>('[role="tablist"]')!;
    // happy-dom has no layout: give the strip a phone's measurements.
    Object.defineProperties(strip, {
      scrollWidth: { configurable: true, value: 420 },
      clientWidth: { configurable: true, value: 358 },
    });
    const scrollTo = async (left: number) => {
      strip.scrollLeft = left;
      await act(async () => strip.dispatchEvent(new Event('scroll')));
    };
    const mask = async () => {
      const states = (['data-overflow-start', 'data-overflow-end'] as const)
        .filter((name) => strip.hasAttribute(name))
        .map((name) => `[${name}]` as const);
      return (await styleFor(strip.className, states))['mask-image'];
    };

    await scrollTo(0);
    expect(await mask()).toBe('linear-gradient(to right,#000 calc(100% - 1.5rem),transparent)');
    await scrollTo(30);
    expect(await mask()).toContain('transparent,#000 1.5rem');
    await scrollTo(62);
    expect(await mask()).toBe('linear-gradient(to left,#000 calc(100% - 1.5rem),transparent)');

    // Nothing out of view: no fade.
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 358 });
    await scrollTo(0);
    expect(await mask()).toBeUndefined();
  });
});
