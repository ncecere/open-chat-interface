import { instanceName } from '@oci/shared';
import { logger } from '../lib/logger.js';
import { getSetting } from './settings.js';

/**
 * The instance's name from Branding, for what the API writes for people:
 * email subjects, bodies and sender names, Markdown export headers and
 * document metadata.
 *
 * Falls back to the product's name when the setting cannot be read, since a
 * branding problem must never block a password reset or a download.
 */
export async function currentAppName(): Promise<string> {
  try {
    return instanceName((await getSetting('branding'))?.appName);
  } catch (error) {
    logger.warn({ error }, 'Could not read the branding setting; using the default name');
    return instanceName(null);
  }
}
