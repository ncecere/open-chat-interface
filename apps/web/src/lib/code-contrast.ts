import type { CodeHighlighterPlugin, HighlightResult } from '@streamdown/code';

/**
 * Syntax colours that read at WCAG AA (4.5:1) on every surface a code block
 * sits on (#171).
 *
 * Shiki's GitHub themes were made for their own backgrounds (#fff, #24292e).
 * On ours some fall short: dark comments (#6A737D) are 3.6-4.2:1 on the dark
 * surfaces, light parameters (#E36209) 3.2-3.5:1 on the light ones. Rather
 * than fork the themes, each token colour that falls short is darkened (light
 * theme) or lightened (dark theme) just enough, keeping its hue, so the
 * palette still reads as GitHub's.
 */

/** The hardest surface for code in each theme: oklch(97%) light, oklch(22%) dark (tokens.css). */
export const CODE_SURFACES = { light: '#f5f5f5', dark: '#1e1e1e' } as const;
const TARGET = 4.6;

function channels(hex: string): [number, number, number] | null {
  const match = hex.match(/^#([\da-f]{6})([\da-f]{2})?$/i);
  if (!match) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(match[1]!.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function ratio(first: [number, number, number], second: [number, number, number]): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

const hex = (rgb: number[]) =>
  `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;

const adjusted = new Map<string, string>();

/** `color`, mixed toward black or white just enough to reach 4.5:1 on `surface`. */
export function readableOn(color: string, surface: string): string {
  const key = `${color}|${surface}`;
  const cached = adjusted.get(key);
  if (cached) return cached;
  const rgb = channels(color);
  const background = channels(surface);
  let result = color;
  if (rgb && background && ratio(rgb, background) < TARGET) {
    const toward = luminance(background) > 0.5 ? 0 : 255;
    const mix = (amount: number) => rgb.map((value) => value + (toward - value) * amount);
    let low = 0;
    let high = 1;
    for (let step = 0; step < 20; step += 1) {
      const middle = (low + high) / 2;
      if (ratio(mix(middle) as [number, number, number], background) >= TARGET) high = middle;
      else low = middle;
    }
    result = hex(mix(high));
  }
  adjusted.set(key, result);
  return result;
}

function readableResult(result: HighlightResult): HighlightResult {
  return {
    ...result,
    tokens: result.tokens.map((line) =>
      line.map((token) => {
        const style = token.htmlStyle;
        if (!style) return token;
        const next = { ...style };
        if (style.color) next.color = readableOn(style.color, CODE_SURFACES.light);
        if (style['--shiki-dark'])
          next['--shiki-dark'] = readableOn(style['--shiki-dark'], CODE_SURFACES.dark);
        return { ...token, htmlStyle: next };
      }),
    ),
  };
}

/** The code plugin with every token colour readable on our surfaces. */
export function readableCodePlugin(plugin: CodeHighlighterPlugin): CodeHighlighterPlugin {
  // Streamdown re-renders only when the result object changes: one per input.
  const results = new WeakMap<HighlightResult, HighlightResult>();
  const readable = (result: HighlightResult) => {
    let cached = results.get(result);
    if (!cached) {
      cached = readableResult(result);
      results.set(result, cached);
    }
    return cached;
  };
  return {
    ...plugin,
    highlight(options, callback) {
      const result = plugin.highlight(
        options,
        callback ? (ready) => callback(readable(ready)) : undefined,
      );
      return result ? readable(result) : null;
    },
  };
}
