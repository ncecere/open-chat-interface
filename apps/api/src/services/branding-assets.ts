import { randomUUID } from 'node:crypto';
import { MIN_INSTALL_LOGO_PX } from '@oci/shared';
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The size a PNG declares in its first chunk (IHDR), or null when the bytes
 * are not a PNG that starts as the format requires. Only the header is read:
 * the logo was type-checked by its bytes when it was stored.
 */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The size of a logo the installed app can use as its icon, or null.
 *
 * Home screens and app switchers draw the icon square and large, so only a
 * PNG that is square and at least 512 px qualifies (the size Chromium asks
 * for); anything else keeps the bundled icons, and is never stretched or
 * cropped. The bytes decide, not the stored type: SVG never qualifies.
 */
export function installableLogoFromBytes(
  bytes: Buffer,
  mimeType: string | null,
): { width: number; height: number } | null {
  if (mimeType !== 'image/png') return null;
  const size = pngSize(bytes);
  if (!size || size.width !== size.height || size.width < MIN_INSTALL_LOGO_PX) return null;
  return size;
}

// A logo's key is random and never rewritten (a replacement is a new key), so
// what was read from it stays true; bounded so a long-lived process that sees
// many replacements does not grow.
const installableLogoCache = new Map<string, { width: number; height: number } | null>();
const INSTALLABLE_LOGO_CACHE_MAX = 16;

/**
 * Whether the configured logo can be the installed app's icon, and its size.
 *
 * Null for no logo, an external URL (it cannot be checked, and an icon must
 * be same-origin), a type other than PNG, a size that is too small or not
 * square, and a logo that cannot be read: a logo that cannot be used never
 * breaks the manifest, which falls back to the bundled icons.
 */
export async function installableLogo(branding: {
  logoUrl: string | null;
  logoMimeType: string | null;
}): Promise<{ width: number; height: number } | null> {
  const key = branding.logoUrl;
  if (!key || !isManagedLogoKey(key) || branding.logoMimeType !== 'image/png') return null;
  if (installableLogoCache.has(key)) return installableLogoCache.get(key) ?? null;

  let size: { width: number; height: number } | null;
  try {
    const driver = await getStorageDriver();
    size = installableLogoFromBytes(await driver.get(key), branding.logoMimeType);
  } catch {
    // Storage unavailable or the object is gone: not cached, so the next
    // request looks again.
    return null;
  }
  if (installableLogoCache.size >= INSTALLABLE_LOGO_CACHE_MAX) installableLogoCache.clear();
  installableLogoCache.set(key, size);
  return size;
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
