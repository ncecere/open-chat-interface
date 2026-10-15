import { describe, expect, it } from 'vitest';
import { ACCENTS, contrast, MODES, resolveColor, tokens } from './css-test-utils';

/**
 * Text on a solid accent fill reads at AA (4.5:1) in every theme and accent
 * (1.4.3, #401). The final accessibility audit found white on the emerald
 * accent in the dark theme at 3.51:1: the sign-in button, the sidebar's
 * button and the badges. The light theme's emerald was already the darker shade.
 *
 * The pairs are the ones the interface puts together: the accent with
 * `--accent-foreground` (badges, avatars, selected controls), and the buttons
 * and the send button, at rest and on hover, with `--accent-button-foreground`.
 */
const PAIRS = [
  { fill: '--accent', text: '--accent-foreground' },
  { fill: '--accent-button', text: '--accent-button-foreground' },
  { fill: '--accent-button-hover', text: '--accent-button-foreground' },
  { fill: '--accent-send', text: '--accent-button-foreground' },
  { fill: '--accent-send-hover', text: '--accent-button-foreground' },
] as const;

describe('solid accent fills', () => {
  for (const mode of MODES) {
    for (const accent of ACCENTS) {
      it(`${mode} ${accent}: text on every fill clears 4.5:1`, () => {
        const values = tokens(mode, accent);
        for (const { fill, text } of PAIRS) {
          const ratio = contrast(
            resolveColor(values[text] ?? '', values),
            resolveColor(values[fill] ?? '', values),
          );
          expect(ratio, `${text} on ${fill}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }
});
