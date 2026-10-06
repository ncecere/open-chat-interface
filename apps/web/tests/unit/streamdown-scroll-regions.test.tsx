// @vitest-environment happy-dom
import { code } from '@streamdown/code';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { afterEach, expect, it, vi } from 'vitest';
import {
  installStreamdownScrollRegions,
  uninstallStreamdownScrollRegions,
} from '../../src/components/chat/streamdown-overlay-focus';

afterEach(() => {
  uninstallStreamdownScrollRegions();
  document.body.innerHTML = '';
});

it("makes a reply's table and code block reachable by keyboard, with names", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  installStreamdownScrollRegions();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <Streamdown mode="static" plugins={{ code }}>
        {'| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst wide = 1;\n```'}
      </Streamdown>,
    ),
  );

  await vi.waitFor(() => {
    const table = container.querySelector('[data-streamdown="table-wrapper"] > .overflow-x-auto');
    const body = container.querySelector('[data-streamdown="code-block-body"]');
    expect(table?.getAttribute('tabindex')).toBe('0');
    expect(table?.getAttribute('aria-label')).toBe('Table 1');
    expect(body?.getAttribute('tabindex')).toBe('0');
    expect(body?.getAttribute('role')).toBe('region');
    // Named for the block (#194).
    expect(body?.getAttribute('aria-label')).toBe('Code block 1 (JavaScript)');
  });
  await act(async () => root.unmount());
});
