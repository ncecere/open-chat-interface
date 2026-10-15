import { symmetricDecrypt } from 'better-auth/crypto';

/**
 * How many recovery codes are left in a `two_factor.backup_codes` value (an
 * encrypted JSON array: the plugin encrypts it with AUTH_SECRET). The codes
 * themselves go no further than this function: only the count is returned, so
 * a status page or an audit entry can say "3 left" and never show one.
 * Null when the value cannot be read (a changed AUTH_SECRET, a damaged row).
 */
export async function countRecoveryCodes(
  secretConfig: Parameters<typeof symmetricDecrypt>[0]['key'],
  stored: string,
): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await symmetricDecrypt({ key: secretConfig, data: stored }));
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}
