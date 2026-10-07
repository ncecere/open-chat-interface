// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Button } from '../../src/components/ui/button';
import { ACCENTS, contrast, MODES, resolveColor, styleFor, tokens } from './css-test-utils';

/**
 * #355: the keyboard focus ring on every filled button was invisible. The ring
 * colour came only from global.css's `:focus-visible`, so unfocused the
 * outline colour was `currentcolor` (the button's text: near white on New Chat
 * and Sign in in light, near black in dark) and `transition-colors`, which
 * includes outline-color, faded the ring in from that over 150 ms. The ring
 * began as the text colour on the page colour (1.04:1), so a person tabbing
 * onto the button, and the QA tool measuring right after, saw no ring.
 *
 * The real Button for every variant and size, its classes compiled by the
 * project's Tailwind and resolved against tokens.css in every theme and accent.
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

/** What a button sits on: pages, sidebar, settings panes, cards and dialogs. */
const SURFACES = [
  '--bg-root',
  '--bg-root-alt',
  '--bg-app',
  '--bg-settings',
  '--bg-pill',
  '--bg-elevated',
  '--bg-sidebar',
  '--bg-control',
] as const;

const VARIANTS = ['primary', 'accent', 'secondary', 'ghost', 'outline', 'danger', 'link'] as const;
const SIZES = ['sm', 'md', 'lg', 'icon', 'icon-sm'] as const;

/** global.css: `:focus-visible { outline: 2px solid var(--accent-bright) }`. */
const GLOBAL_RING = 'var(--accent-bright)';

async function renderButton(variant: (typeof VARIANTS)[number], size: (typeof SIZES)[number]) {
  await act(async () =>
    root.render(
      <Button variant={variant} size={size}>
        Label
      </Button>,
    ),
  );
  return container.querySelector<HTMLButtonElement>('button')!.className;
}

describe('keyboard focus ring on every Button variant (#355)', () => {
  for (const variant of VARIANTS) {
    it(`${variant}: a 2 px ring from the first frame, clear of every surface and its own fill`, async () => {
      for (const size of SIZES) {
        const classes = await renderButton(variant, size);
        const idle = await styleFor(classes);
        const focused = await styleFor(classes, [':focus', ':focus-visible']);

        for (const mode of MODES) {
          for (const accent of ACCENTS) {
            const values = tokens(mode, accent);
            const where = `${variant} ${size} ${mode} ${accent}`;
            const ring = resolveColor(focused['outline-color'] ?? GLOBAL_RING, values);
            const text = resolveColor(idle.color ?? 'var(--text-primary)', values);

            // transition-colors fades outline-color from its unfocused value:
            // every colour the ring passes through must be visible too.
            const fades = (idle['transition-property'] ?? '').includes('outline-color');
            const colours = [ring];
            if (fades) {
              colours.push(
                idle['outline-color'] ? resolveColor(idle['outline-color'], values) : text,
              );
            }
            for (const colour of colours) {
              for (const surface of SURFACES) {
                expect(
                  contrast(colour, resolveColor(`var(${surface})`, values)),
                  `${where}: ring ${colour} on ${surface}`,
                ).toBeGreaterThanOrEqual(3);
              }
            }

            // A filled button also shows a thin inner ring in its text colour.
            const fill = idle['background-color'];
            if (fill) {
              expect(focused['--tw-shadow'], `${where}: inner ring on the ${fill} fill`).toMatch(
                /inset 0 0 0 2px .*currentcolor/i,
              );
              expect(
                contrast(text, resolveColor(fill, values)),
                `${where}: inner ring against the fill`,
              ).toBeGreaterThanOrEqual(3);
            }
          }
        }
      }
    });
  }
});

describe('outline colour on elements that are not focused (#355)', () => {
  it('global.css gives every element the ring colour, so transition-colors has nothing to fade', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/global.css'), 'utf8');
    expect(css).toMatch(
      /\*,\s*::before,\s*::after\s*\{\s*outline-color:\s*var\(--accent-bright\);/,
    );
  });
});

/** Every `focus…:outline-[var(--x)]` or ring colour in the app's own sources. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?)$/.test(name) ? [path] : [];
  });
}

describe('focus ring colours set by other components (#355)', () => {
  const RING =
    /(?:focus(?:-visible|-within)?|has-\[:focus-visible\]):(?:outline|ring)-\[var\((--[\w-]+)\)\]/g;
  const used = new Map<string, string[]>();
  for (const file of sources(join(process.cwd(), 'src'))) {
    for (const [, token] of readFileSync(file, 'utf8').matchAll(RING)) {
      used.set(token!, [...(used.get(token!) ?? []), file.replace(`${process.cwd()}/`, '')]);
    }
  }

  it('finds the rings to check', () => {
    expect(used.get('--accent-bright')?.length).toBeGreaterThan(5);
  });

  it('every ring colour clears 3:1 on the surfaces in every theme and accent', () => {
    const failures: string[] = [];
    for (const [token, files] of used) {
      for (const mode of MODES) {
        for (const accent of ACCENTS) {
          const values = tokens(mode, accent);
          for (const surface of SURFACES) {
            const ratio = contrast(
              resolveColor(`var(${token})`, values),
              resolveColor(`var(${surface})`, values),
            );
            if (ratio < 3) {
              failures.push(
                `${token} (${files[0]}) on ${surface}, ${mode} ${accent}: ${ratio.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
