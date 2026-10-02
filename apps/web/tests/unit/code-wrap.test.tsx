// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from '../../src/providers/theme-provider';

let root: Root | undefined;
let container: HTMLDivElement;
let setCodeWrap: ((enabled: boolean) => void) | undefined;

function Probe() {
  const theme = useTheme();
  setCodeWrap = theme.setCodeWrap;
  return <output data-wrap={String(theme.codeWrap)} />;
}

async function render() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    ),
  );
}

const html = document.documentElement;

beforeEach(() => {
  localStorage.clear();
  html.className = '';
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
});

it('leaves code unwrapped by default', async () => {
  await render();
  expect(container.querySelector('output')?.dataset.wrap).toBe('false');
  expect(html.classList.contains('code-wrap')).toBe(false);
});

it('remembers the choice and marks the page so code blocks wrap', async () => {
  await render();
  await act(async () => setCodeWrap?.(true));
  expect(html.classList.contains('code-wrap')).toBe(true);
  expect(localStorage.getItem('oci.codeWrap')).toBe('true');

  await act(async () => root?.unmount());
  container.remove();
  html.className = '';
  await render();
  expect(container.querySelector('output')?.dataset.wrap).toBe('true');
  expect(html.classList.contains('code-wrap')).toBe(true);
});
