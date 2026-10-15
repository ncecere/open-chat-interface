import { Hono } from 'hono';
import type { AppBindings } from '../middleware/context.js';
import { installableLogo } from '../services/branding-assets.js';
import { buildManifest } from '../services/manifest.js';
import { getSetting } from '../services/settings.js';

export const manifestRoutes = new Hono<AppBindings>();

/**
 * The instance's default language. Branding has no language setting yet (the
 * translation module adds one); until it does, the manifest says English, which
 * is what every page is in.
 */
const MANIFEST_LANGUAGE = 'en';

/**
 * The web app manifest (#400): what a browser reads to offer installing the
 * app, named and coloured as the instance is branded.
 *
 * Unauthenticated, like /api/auth/status and the logo: a browser fetches it
 * without cookies, and the name is already public on the sign-in page. It is
 * cached for five minutes, so a change to Branding reaches an installed app's
 * next manifest check within that time. Only name, colours and icon URLs are
 * ever in it (services/manifest.ts).
 */
manifestRoutes.get('/', async (c) => {
  const branding = await getSetting('branding');
  const logo = await installableLogo(branding);
  const manifest = buildManifest(branding, { lang: MANIFEST_LANGUAGE, logo });

  return c.body(JSON.stringify(manifest), 200, {
    'content-type': 'application/manifest+json; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  });
});
