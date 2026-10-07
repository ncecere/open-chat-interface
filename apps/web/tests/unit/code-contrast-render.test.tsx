// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HighlightedCode } from '../../src/components/chat/markdown';
import { CODE_SURFACES } from '../../src/lib/code-contrast';
import { contrast } from './css-test-utils';

/** #171: what a code block actually renders carries the readable colours. */
it('renders a comment in colours that clear 4.5:1 in both themes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<HighlightedCode source={'// Adds two numbers\nconst a = 1;'} language="ts" />),
  );
  const comment = await vi.waitFor(
    () => {
      const span = [...container.querySelectorAll<HTMLElement>('span')].find(
        (node) =>
          node.textContent === '// Adds two numbers' &&
          node.style.getPropertyValue('--sdm-c').startsWith('#'),
      );
      // Plain (`inherit`) until Shiki's colours arrive.
      if (!span) throw new Error('not highlighted yet');
      return span;
    },
    { timeout: 10_000 },
  );
  const light = comment.style.getPropertyValue('--sdm-c');
  const dark = comment.style.getPropertyValue('--shiki-dark');
  expect(contrast(light, CODE_SURFACES.light)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(dark, CODE_SURFACES.dark)).toBeGreaterThanOrEqual(4.5);
  await act(async () => root.unmount());
  container.remove();
});
