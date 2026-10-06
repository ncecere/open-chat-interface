// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ArtifactCard } from '../../src/components/artifacts/artifact-card';
import type { ArtifactRef } from '../../src/components/artifacts/artifacts-context';
import { styleFor } from './css-test-utils';
import { clippedOnTouch, clippedWithoutTooltip } from './truncation';

/**
 * #336 (a gap in #312): the card in a conversation that opens the artifact
 * panel cut a long title with an ellipsis and had no tooltip, at every width
 * and, with the panel docked, at 1024 px. Like the panel's own title, it wraps:
 * a tooltip is no help on touch (#244).
 */
const TITLE = 'Walk8 Visual Artifact: CSV Research Dataset Summary Parser';

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

const artifact = {
  sourceKey: 'k1',
  kind: 'code',
  language: 'python',
  title: TITLE,
  version: 1,
} as unknown as ArtifactRef;

it('shows the whole title, wrapped rather than cut short', async () => {
  await act(async () =>
    root.render(<ArtifactCard artifact={artifact} onOpen={() => undefined} note="Updated" />),
  );
  const card = container.querySelector('button')!;
  expect(card.getAttribute('aria-label')).toBe(`Open artifact: ${TITLE}`);
  expect(card.textContent).toContain(TITLE);
  expect(await clippedOnTouch(container)).toEqual([]);
  expect(await clippedWithoutTooltip(container)).toEqual([]);
});

it('lets a long unbroken title wrap inside the card, not widen it', async () => {
  const unbroken = 'A'.repeat(120);
  await act(async () =>
    root.render(
      <ArtifactCard artifact={{ ...artifact, title: unbroken }} onOpen={() => undefined} />,
    ),
  );
  const title = [...container.querySelectorAll('span')].find(
    (node) => node.textContent === unbroken,
  )!;
  const style = await styleFor(title.getAttribute('class') ?? '');
  expect(style['overflow-wrap']).toBe('anywhere');
});
