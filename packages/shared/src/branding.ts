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

/**
 * The page surface of each mode (`--bg-root` in apps/web/src/styles/tokens.css,
 * oklch 17% and 100%, as hex). The installed app's splash screen and, for the
 * neutral theme, its title bar take it, so the app opens without a flash of
 * another colour. A web unit test converts the tokens again and fails if the
 * two drift apart.
 */
export const BRAND_SURFACES = { dark: '#0f0f0f', light: '#ffffff' } as const;

export type BrandMode = keyof typeof BRAND_SURFACES;

/**
 * The mode an installed app starts in: the instance default theme. "System"
 * cannot be known by a manifest that is the same for every visitor, so it
 * starts dark, as index.html does before the theme is applied.
 */
export function brandMode(defaultTheme: string | null | undefined): BrandMode {
  return defaultTheme === 'light' ? 'light' : 'dark';
}

/** The splash-screen colour (`background_color`) for a mode. */
export function brandBackgroundColor(mode: BrandMode): string {
  return BRAND_SURFACES[mode];
}

/**
 * The browser or title-bar colour (`theme_color`, and the `theme-color` meta
 * tag): the accent of a hued colour theme, which reads the same in both
 * modes. The neutral theme has no hue (its accent is black or white), so it
 * takes the page surface; an unknown theme is neutral.
 */
export function brandThemeColor(colorTheme: string | null | undefined, mode: BrandMode): string {
  if (colorTheme === 'blue' || colorTheme === 'violet' || colorTheme === 'emerald') {
    return DIAGRAM_ACCENTS[colorTheme];
  }
  return BRAND_SURFACES[mode];
}

/** The smallest side of a logo the installed app may use as its icon (#400). */
export const MIN_INSTALL_LOGO_PX = 512;

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

/** Android and iOS truncate a longer label under the home-screen icon (#400). */
export const BRAND_SHORT_NAME_MAX = 12;

/**
 * The label under the installed app's icon: the configured short name, or the
 * start of the name, at most 12 characters and never half of a character
 * made of two code units. The manifest and the Apple title tag use it alike.
 */
export function brandShortName(
  appName: string | null | undefined,
  shortName: string | null | undefined,
): string {
  const label = shortName?.trim() || instanceName(appName);
  return Array.from(label).slice(0, BRAND_SHORT_NAME_MAX).join('').trimEnd();
}

// This package compiles without DOM or Node types; both runtimes provide URL.
declare const URL: new (input: string) => { protocol: string; username: string; password: string };

/**
 * A logo address the sign-in page may load: http(s) without credentials, or a
 * root-relative path on this instance. Shared by the Branding form and the
 * settings API, which stored anything (a `javascript:` URL included).
 */
export function isSafeImageUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}
