import { ENCRYPTED_LOCATIONS } from '@oci/db';
import { describe, expect, it } from 'vitest';

/**
 * The authenticator's secret and the recovery codes are encrypted by Better
 * Auth's plugin with AUTH_SECRET, not with ENCRYPTION_KEY (SPEC-mfa.md,
 * "Secrets"): no option replaces that for the TOTP secret, and wrapping the
 * column in OCI's envelope would break the plugin's compare-and-swap on the
 * stored ciphertext. So `two_factor` must NOT be a location the ENCRYPTION_KEY
 * rotation re-encrypts: it would try ENCRYPTION_KEY on AUTH_SECRET ciphertext
 * and fail the whole batch (docs/dev/database.md, "Encrypted secrets").
 *
 * The consequences are documented instead: changing AUTH_SECRET makes every
 * authenticator unreadable (`admin:reset-mfa --all --yes`), and a backup of
 * the database carries secrets only AUTH_SECRET opens.
 */
describe('ENCRYPTED_LOCATIONS and two-step verification', () => {
  it('does not list the two_factor table or the passkey table', () => {
    const tables = ENCRYPTED_LOCATIONS.map((location) => location.table);
    expect(tables).not.toContain('two_factor');
    expect(tables).not.toContain('passkey');
    expect(tables.sort()).toEqual([
      'connector',
      'connector_account',
      'instance_setting',
      'provider',
      'webhook_endpoint',
    ]);
  });

  it('does not list a secret or recovery-code column of any table', () => {
    for (const location of ENCRYPTED_LOCATIONS) {
      expect(location.columns).not.toContain('secret');
      expect(location.columns).not.toContain('backup_codes');
    }
  });
});
