import {
  type BrandMode,
  brandBackgroundColor,
  brandMode,
  brandThemeColor,
  instanceName,
  MIN_INSTALL_LOGO_PX,
} from '@oci/shared';

/**
 * The web app manifest an instance serves (#400).
 *
 * A static manifest cannot carry the instance's name, so the API builds it
 * from Branding. This file is the pure part: everything the manifest contains
 * is decided here, from values passed in, and nothing is read or cached.
 *
 * The output is limited to the fields below. It is public (the name is
 * already on the sign-in page), so it never carries anything that is not.
 */

/** Android and iOS truncate a longer label under the icon. */
export const MANIFEST_SHORT_NAME_MAX = 12;

export interface ManifestBranding {
  appName: string | null | undefined;
  shortName: string | null | undefined;
  colorTheme: string | null | undefined;
  defaultTheme: string | null | undefined;
}

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: 'image/png';
  purpose: 'any' | 'maskable';
}

export interface WebManifest {
  name: string;
  short_name: string;
  id: '/';
  start_url: '/';
  scope: '/';
  display: 'standalone';
  lang: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

/**
 * OCI's own icons, made from the mark in apps/web/public/favicon.svg. The
 * maskable one has the mark inside the central 80% circle, which is all a
 * launcher is guaranteed to show.
 */
export const BUNDLED_ICONS: ManifestIcon[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/** Where an uploaded logo is served (routes/branding.ts). */
const LOGO_ICON_URL = '/api/branding/logo';

/** The first `max` characters, never half of a character made of two code units. */
function firstCharacters(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('').trimEnd();
}

/**
 * @param logo the size of the instance's logo when it can be the icon
 *   (`installableLogo`), or null. Checked again here: a logo that is too
 *   small or not square would be drawn blurred or cropped, so it is ignored.
 */
export function buildManifest(
  branding: ManifestBranding,
  options: { lang: string; logo: { width: number; height: number } | null },
): WebManifest {
  const name = instanceName(branding.appName);
  const mode: BrandMode = brandMode(branding.defaultTheme);
  const logo = options.logo;
  const useLogo = Boolean(logo && logo.width === logo.height && logo.width >= MIN_INSTALL_LOGO_PX);

  return {
    name,
    short_name: firstCharacters(branding.shortName?.trim() || name, MANIFEST_SHORT_NAME_MAX),
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: options.lang,
    theme_color: brandThemeColor(branding.colorTheme, mode),
    background_color: brandBackgroundColor(mode),
    icons:
      useLogo && logo
        ? [
            {
              src: LOGO_ICON_URL,
              sizes: `${logo.width}x${logo.height}`,
              type: 'image/png',
              purpose: 'any',
            },
          ]
        : BUNDLED_ICONS,
  };
}
