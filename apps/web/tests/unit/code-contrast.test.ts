import { code, type HighlightResult } from '@streamdown/code';
import { describe, expect, it } from 'vitest';
import { readableCodePlugin } from '../../src/lib/code-contrast';
import { contrast, MODES, tokens } from './css-test-utils';

/**
 * #171: highlighted code reads at AA (4.5:1) on every surface a code block
 * sits on, in both themes. Real Shiki (the code plugin replies use), real
 * GitHub themes, and the surfaces from tokens.css.
 */
const SURFACES = [
  '--bg-root',
  '--bg-root-alt',
  '--bg-app',
  '--bg-elevated',
  '--bg-control',
  '--bg-control-alt',
  '--bg-settings',
  '--bg-inset',
];

const SAMPLES = {
  typescript: [
    '// Adds two numbers',
    'export function add(first: number, second = 2): number {',
    '  /* a block comment */',
    "  const label = 'sum' + first; // trailing note",
    '  return first + second;',
    '}',
  ].join('\n'),
  bash: ['# Install and run', 'npm install --save-dev vitest', 'echo "$HOME" | grep -v x'].join(
    '\n',
  ),
  python: ['def add_two(a, b):', '    """Return the sum."""', '    return a + b  # done'].join(
    '\n',
  ),
};

function highlight(language: keyof typeof SAMPLES): Promise<HighlightResult> {
  const plugin = readableCodePlugin(code);
  return new Promise((resolve) => {
    const ready = plugin.highlight(
      { code: SAMPLES[language], language, themes: plugin.getThemes() },
      resolve,
    );
    if (ready) resolve(ready);
  });
}

describe('code block colours (#171)', () => {
  it.each(Object.keys(SAMPLES) as (keyof typeof SAMPLES)[])(
    'clear 4.5:1 on every surface in both themes: %s',
    async (language) => {
      const result = await highlight(language);
      const failures: string[] = [];
      for (const mode of MODES) {
        const values = tokens(mode, 'neutral');
        for (const token of result.tokens.flat()) {
          if (!token.content.trim()) continue;
          const color = token.htmlStyle?.[mode === 'light' ? 'color' : '--shiki-dark'];
          if (!color) continue;
          for (const surface of SURFACES) {
            const value = contrast(color, values[surface]!);
            if (value < 4.5)
              failures.push(
                `${mode} "${token.content}" ${color} on ${surface}: ${value.toFixed(2)}`,
              );
          }
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it('leaves colours that already pass as they are', async () => {
    const result = await highlight('typescript');
    const keyword = result.tokens.flat().find((token) => token.content === 'export');
    // GitHub's dark-theme keyword red passes on every dark surface: untouched.
    expect(keyword?.htmlStyle?.['--shiki-dark']?.toLowerCase()).toBe('#f97583');
    // Its light-theme red is 4.4:1 on the grey surfaces: darkened a little, still red.
    expect(keyword?.htmlStyle?.color?.toLowerCase()).toMatch(/^#[c-d][0-9a-f]3[0-9a-f]4[0-9a-f]$/);
  });
});
