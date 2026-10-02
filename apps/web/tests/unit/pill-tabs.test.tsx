// @vitest-environment happy-dom
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { PillTabs } from '../../src/components/ui/pill-tabs';
import { cleanup, renderAdmin } from './admin-test-utils';

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
