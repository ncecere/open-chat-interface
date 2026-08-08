import { Hono } from 'hono';
import { notFound } from '../lib/errors.js';
import type { AppBindings } from '../middleware/context.js';
import { isManagedLogoKey } from '../services/branding-assets.js';
import { getSetting } from '../services/settings.js';
import { getStorageDriver } from '../services/storage/index.js';

export const brandingRoutes = new Hono<AppBindings>();

/**
 * Serves the instance logo.
 *
 * Deliberately unauthenticated: the sign-in page shows the logo before anyone
 * has an account, so requiring a session would leave it blank exactly where it
 * matters most. Only the single configured key is ever read, so this cannot be
 * used to reach any other object in storage.
 */
brandingRoutes.get('/logo', async (c) => {
  const branding = await getSetting('branding');
  if (!isManagedLogoKey(branding.logoUrl)) throw notFound('No logo is configured');

  const driver = await getStorageDriver();
  const bytes = await driver.get(branding.logoUrl as string);

  return c.body(bytes as unknown as ArrayBuffer, 200, {
    'content-type': branding.logoMimeType ?? 'application/octet-stream',
    'content-length': String(bytes.byteLength),
    // Keyed by a random filename, so a replacement produces a new URL and the
    // old one can be cached hard without going stale.
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
  });
});
