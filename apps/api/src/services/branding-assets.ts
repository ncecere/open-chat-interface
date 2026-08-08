import { randomUUID } from 'node:crypto';
import { validationFailed } from '../lib/errors.js';
import { getStorageDriver } from './storage/index.js';

/** A logo is displayed in a header, so it never needs to be large. */
const MAX_LOGO_BYTES = 1024 * 1024;

/**
 * Raster and vector marks an instance is likely to have.
 *
 * SVG is deliberately excluded: it can carry scripts, and the logo is rendered
 * on the sign-in page before anyone has authenticated. Accepting it would turn
 * a branding upload into stored cross-site scripting.
 */
const ALLOWED_LOGO_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Magic bytes, so a renamed file cannot pass as an image. */
function detectImageType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export interface StoredLogo {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Stores an instance logo and returns the key it was written under.
 *
 * Kept apart from attachments: a logo belongs to the instance rather than to a
 * person, has no quota, and is served to anonymous visitors.
 */
export async function storeInstanceLogo(params: {
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
}): Promise<StoredLogo> {
  if (params.bytes.byteLength === 0) throw validationFailed('The logo file is empty');
  if (params.bytes.byteLength > MAX_LOGO_BYTES) {
    throw validationFailed('The logo must be 1 MB or smaller');
  }

  // The declared type is a hint from the client; the bytes decide.
  const detected = detectImageType(params.bytes);
  if (!detected || !ALLOWED_LOGO_TYPES[detected]) {
    throw validationFailed('The logo must be a PNG, JPEG, or WebP image');
  }

  const extension = ALLOWED_LOGO_TYPES[detected];
  const storageKey = `branding/logo-${randomUUID()}.${extension}`;
  const driver = await getStorageDriver();
  await driver.put(storageKey, params.bytes, detected);

  return { storageKey, mimeType: detected, sizeBytes: params.bytes.byteLength };
}

/** Whether a stored logo reference points at instance branding. */
export function isManagedLogoKey(value: string | null): boolean {
  return Boolean(value?.startsWith('branding/'));
}

/**
 * The URL a client should use for the logo.
 *
 * An uploaded logo is stored under a key rather than a URL, so it is exposed
 * through the branding route; an external link is passed through unchanged.
 */
export function publicLogoUrl(logoUrl: string | null): string | null {
  if (!logoUrl) return null;
  return isManagedLogoKey(logoUrl) ? '/api/branding/logo' : logoUrl;
}
