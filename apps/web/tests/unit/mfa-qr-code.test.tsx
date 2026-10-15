// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { QrCode } from '../../src/components/mfa/qr-code';

const URI =
  'otpauth://totp/Open%20Chat%20Interface:pat%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Open%20Chat%20Interface';
const MARGIN = 4;

let container: HTMLDivElement | undefined;
afterEach(() => {
  container?.remove();
  container = undefined;
});

async function render(value: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<QrCode value={value} />));
  return container.querySelector('svg')!;
}

/** The dark modules the path draws, as `row,column` after removing the quiet zone. */
function darkModules(svg: SVGElement): Set<string> {
  const d = svg.querySelector('path')!.getAttribute('d')!;
  const set = new Set<string>();
  for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g))
    set.add(`${Number(y) - MARGIN},${Number(x) - MARGIN}`);
  return set;
}

it('draws the code as an SVG that is hidden from assistive technology', async () => {
  const svg = await render(URI);
  // The manual key and the link are the accessible alternative.
  expect(svg.getAttribute('aria-hidden')).toBe('true');
  expect(svg.getAttribute('focusable')).toBe('false');
  expect(svg.getAttribute('role')).toBeNull();
  const [, , width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
  expect(width).toBe(height);
  // A quiet zone of four modules on each side, as the QR standard asks.
  expect(width! - 2 * MARGIN).toBeGreaterThanOrEqual(21);
});

it('draws the three finder patterns where a scanner looks for them', async () => {
  const svg = await render(URI);
  const dark = darkModules(svg);
  const size = Number(svg.getAttribute('viewBox')!.split(' ')[2]) - 2 * MARGIN;
  const finder = (top: number, left: number) => {
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 7; col++) {
        const edge = row === 0 || row === 6 || col === 0 || col === 6;
        const core = row >= 2 && row <= 4 && col >= 2 && col <= 4;
        expect(dark.has(`${top + row},${left + col}`), `${top + row},${left + col}`).toBe(
          edge || core,
        );
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
});

it('draws a different code for a different link', async () => {
  const a = darkModules(await render(URI));
  container?.remove();
  const b = darkModules(await render(URI.replace('JBSWY3DPEHPK3PXP', 'MFRGGZDFMZTWQ2LK')));
  expect([...a].sort().join('|')).not.toBe([...b].sort().join('|'));
});
