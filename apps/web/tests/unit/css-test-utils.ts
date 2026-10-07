import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'tailwindcss';

/**
 * Real CSS for unit tests of colour and focus styling.
 *
 * happy-dom does not run Tailwind, so a class string alone says nothing about
 * what a person sees. These helpers compile an element's classes with the
 * project's Tailwind version, apply the generated rules for a given state
 * (such as :focus-visible) in cascade order, and resolve the result against
 * the real tokens.css, so a test can measure the contrast on screen.
 */

/** A fresh compiler each time: one accumulates every class it has built. */
function tailwind() {
  // The spacing scale, so `top-6` and `size-8` are generated as in the app.
  return compile('@theme { --spacing: 0.25rem; } @tailwind utilities;', {
    base: process.cwd(),
    loadStylesheet: async () => {
      throw new Error('No stylesheet imports in tests');
    },
  });
}

/** The pseudo-classes and attributes an element is in, for matching variants. */
export type ElementState = ':focus' | ':focus-visible' | ':hover' | `[${string}]`;

/**
 * The declarations Tailwind generates for `classes` that apply in `states`,
 * last one winning (Tailwind sorts variants after base utilities), with the
 * library's own `var(--tw-…)` indirections resolved.
 */
export async function styleFor(
  classes: string,
  states: readonly ElementState[] = [],
): Promise<Record<string, string>> {
  const css = (await tailwind()).build(classes.split(/\s+/).filter(Boolean));
  const style: Record<string, string> = {};
  // Flat rules only: nested ones (hover's media query) are not needed here.
  for (const [, selector, body] of css.matchAll(/^([.][^{\n]+)\{([^{}]*)\}/gm)) {
    // Anything after the escaped class name is the variant's condition.
    const conditions = selector!.trim().replace(/^\.(?:\\.|[^\s:[\\])+/, '');
    // A rule for descendants or siblings (`[&_svg]:size-4`) is not the element's own.
    if (/[\s>+~]/.test(conditions)) continue;
    const parts = conditions.match(/:[a-z-]+|\[[^\]]+\]/g) ?? [];
    if (!parts.every((part) => states.includes(part as ElementState))) continue;
    for (const declaration of body!.split(';')) {
      const [property, ...value] = declaration.split(':');
      if (property?.trim() && value.length) style[property.trim()] = value.join(':').trim();
    }
  }
  for (const [property, value] of Object.entries(style)) {
    style[property] = value.replace(
      /var\((--tw-[a-z-]+)\)/g,
      (_, name: string) => style[name] ?? 'solid',
    );
  }
  return style;
}

const tokensPath = ['src/styles/tokens.css', 'apps/web/src/styles/tokens.css']
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate));
const tokensCss = readFileSync(tokensPath ?? 'src/styles/tokens.css', 'utf8');

export const MODES = ['dark', 'light'] as const;
export const ACCENTS = ['neutral', 'blue', 'violet', 'emerald'] as const;

/**
 * The custom properties in effect on <html class="{mode}" data-color-theme="{accent}">,
 * by specificity and then source order, as the browser would resolve them.
 */
export function tokens(
  mode: (typeof MODES)[number],
  accent: (typeof ACCENTS)[number],
): Record<string, string> {
  const applies = (selector: string) =>
    selector
      .replace(/:root/, '')
      .replace(`[data-color-theme="${accent}"]`, '')
      .replace(`.${mode}`, '') === '';
  const specificity = (selector: string) => (selector.match(/:root|\.|\[/g) ?? []).length;
  const blocks: { specificity: number; order: number; body: string }[] = [];
  const source = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [index, match] of [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].entries()) {
    const selectors = match[1]!.split(',').map((selector) => selector.trim());
    if (selectors.some((selector) => selector.startsWith('@'))) continue;
    const matching = selectors.filter(applies);
    if (matching.length === 0) continue;
    blocks.push({
      specificity: Math.max(...matching.map(specificity)),
      order: index,
      body: match[2]!,
    });
  }
  blocks.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const values: Record<string, string> = {};
  for (const block of blocks) {
    for (const [, name, value] of block.body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      values[name!] = value!.trim();
    }
  }
  return values;
}

/** Resolves `var(--x)` (once nested) against a token set. */
export function resolveColor(value: string, values: Record<string, string>): string {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    const reference = current.match(/^var\((--[\w-]+)\)$/);
    if (!reference) return current;
    const next = values[reference[1]!];
    if (!next) throw new Error(`Unknown token ${reference[1]}`);
    current = next;
  }
  return current;
}

/** Linear sRGB channels (0–1) for an oklch() or #hex colour. */
function linearRgb(color: string): [number, number, number] {
  const hex = color.match(/^#([\da-f]{6})$/i);
  if (hex) {
    return [0, 2, 4].map((offset) => {
      const channel = Number.parseInt(hex[1]!.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
  }
  const oklch = color.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!oklch) throw new Error(`Unsupported colour ${color}`);
  const L = Number(oklch[1]) / 100;
  const chroma = Number(oklch[2]);
  const hue = (Number(oklch[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** WCAG 2 contrast ratio between two colours (oklch() or #hex). */
export function contrast(first: string, second: string): number {
  const luminance = (color: string) => {
    const [r, g, b] = linearRgb(color);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/**
 * A length from generated CSS in pixels (16px rem): `12px`, `4.25rem`, `0`,
 * or Tailwind's spacing scale, `var(--spacing)` and `calc(var(--spacing) * N)`.
 */
export function toPx(value: string | undefined): number {
  if (value === undefined) return 0;
  if (value === 'var(--spacing)') return 4;
  const spacing = value.match(/^calc\(var\(--spacing\) \* (-?[\d.]+)\)$/);
  if (spacing) return Number(spacing[1]) * 4;
  const length = value.match(/^(-?[\d.]+)(px|rem)?$/);
  if (!length) throw new Error(`Unsupported length ${value}`);
  return Number(length[1]) * (length[2] === 'rem' ? 16 : 1);
}
