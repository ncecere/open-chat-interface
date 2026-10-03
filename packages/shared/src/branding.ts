import type { ColorTheme } from './constants.js';

/**
 * The product's own name: the default instance name, and what every surface
 * falls back to when the branding setting cannot be read.
 */
export const DEFAULT_APP_NAME = 'Open Chat Interface';

/**
 * The accent diagrams are drawn with, for each colour theme (v0.10).
 *
 * Diagrams are drawn on light paper whatever the app's own theme, so each
 * hued theme uses its light-mode `--accent` from apps/web/src/styles/tokens.css
 * (Tailwind blue-600, violet-600, emerald-700), converted from OKLCH. Each
 * reads at 4.8:1 or better on the diagram paper (#f5f5f5). A web unit test
 * converts the tokens again and fails if the two drift apart.
 *
 * Neutral has no hue: its accent is near-black in light mode, which would be
 * indistinguishable from the diagram ink (#2d3142). It keeps Diagram Design's
 * own orange, which is also what every diagram used before v0.10.
 */
export const DIAGRAM_ACCENTS: Record<ColorTheme, string> = {
  neutral: '#eb6c36',
  blue: '#155dfc',
  violet: '#7f22fe',
  emerald: '#007a55',
};

/** #rgb, #rgba, #rrggbb or #rrggbbaa. */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The diagram accent for an instance's branding.
 *
 * `accentColor` cannot be set from the Branding page; it is an API-only
 * override (PATCH /api/admin/settings) for an instance whose house colour is
 * none of the themes. When it is unset or not a hex colour, the colour theme
 * decides, and an unknown theme falls back to neutral.
 */
export function diagramAccent(branding: {
  colorTheme?: string | null;
  accentColor?: string | null;
}): string {
  const override = branding.accentColor;
  if (typeof override === 'string' && HEX_COLOR_PATTERN.test(override)) return override;
  return DIAGRAM_ACCENTS[branding.colorTheme as ColorTheme] ?? DIAGRAM_ACCENTS.neutral;
}

/** The instance name to show: the configured one, or the product's. */
export function instanceName(appName: string | null | undefined): string {
  return appName?.trim() || DEFAULT_APP_NAME;
}
