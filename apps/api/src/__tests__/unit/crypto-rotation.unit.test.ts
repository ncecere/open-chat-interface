import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Encryption key rotation (v0.11 design, item 23): the versioned format with
 * a key id, values written before v0.11 still readable, decryption with
 * previous keys, and clear failures.
 */
const keys = vi.hoisted(() => ({
  current: 'current-encryption-key-with-at-least-32-chars',
  previous: undefined as string | undefined,
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      ENCRYPTION_KEY: keys.current,
      ENCRYPTION_KEYS_PREVIOUS: keys.previous,
    }),
  };
});

const {
  CIPHERTEXT_PREFIX,
  SecretDecryptionError,
  ciphertextKeyId,
  currentCiphertextPrefix,
  decryptSecret,
  encryptSecret,
  encryptSecretVersioned,
  encryptionKeyId,
  encryptionKeyIds,
  isCurrentCiphertext,
  parsePreviousKeys,
  reencryptSecret,
  setVersionedCiphertext,
  versionedCiphertextEnabled,
} = await import('../../lib/crypto.js');
const { parseEnv } = await import('../../config/env.js');

const OLD = 'old-encryption-key-also-at-least-32-characters';
const OLDER = 'older-encryption-key-also-at-least-32-characters';
const CURRENT = 'current-encryption-key-with-at-least-32-chars';

/** Exactly what v0.10 (lib/crypto.ts before v0.11) stored. */
function v010Encrypt(plaintext: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

afterEach(() => {
  keys.current = CURRENT;
  keys.previous = undefined;
  setVersionedCiphertext(false);
});

describe('unit: ciphertext formats', () => {
  it('reads a value written by v0.10 (no prefix) with the current key', () => {
    const stored = v010Encrypt('sk-legacy', CURRENT);
    expect(ciphertextKeyId(stored)).toBeNull();
    expect(decryptSecret(stored)).toBe('sk-legacy');
  });

  it('writes the legacy format until every replica runs v0.11, then the versioned one', () => {
    expect(versionedCiphertextEnabled()).toBe(false);
    const before = encryptSecret('sk-1');
    expect(before.startsWith(CIPHERTEXT_PREFIX)).toBe(false);
    // A v0.10 replica could read it: the same algorithm and key, no prefix.
    expect(decryptSecret(before)).toBe('sk-1');

    setVersionedCiphertext(true);
    const after = encryptSecret('sk-1');
    expect(after).toMatch(/^oci:v1:[0-9a-f]{12}:[A-Za-z0-9+/=]+$/);
    expect(ciphertextKeyId(after)).toBe(encryptionKeyId(CURRENT));
    expect(after.startsWith(currentCiphertextPrefix())).toBe(true);
    expect(isCurrentCiphertext(after)).toBe(true);
    expect(isCurrentCiphertext(before)).toBe(false);
    expect(decryptSecret(after)).toBe('sk-1');
  });

  it('names a key without revealing it', () => {
    const id = encryptionKeyId(CURRENT);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(id).not.toBe(encryptionKeyId(OLD));
    expect(createHash('sha256').update(CURRENT).digest('hex')).not.toContain(id);
  });
});

describe('unit: rotating ENCRYPTION_KEY', () => {
  it('decrypts values under a previous key, legacy and versioned', () => {
    keys.current = OLD;
    const versioned = encryptSecretVersioned('sk-versioned');
    const legacy = v010Encrypt('sk-legacy', OLD);
    const older = v010Encrypt('sk-older', OLDER);

    keys.current = CURRENT;
    keys.previous = ` ${OLD} ,, ${OLDER} `;
    expect(encryptionKeyIds()).toEqual({
      current: encryptionKeyId(CURRENT),
      previous: [encryptionKeyId(OLD), encryptionKeyId(OLDER)],
    });
    expect(decryptSecret(versioned)).toBe('sk-versioned');
    expect(decryptSecret(legacy)).toBe('sk-legacy');
    expect(decryptSecret(older)).toBe('sk-older');
  });

  it('re-encrypts under the current key in the versioned format, leaving current values alone', () => {
    keys.current = OLD;
    const old = encryptSecretVersioned('sk-1');
    keys.current = CURRENT;
    keys.previous = OLD;

    const rewritten = reencryptSecret(old);
    expect(ciphertextKeyId(rewritten)).toBe(encryptionKeyId(CURRENT));
    expect(decryptSecret(rewritten)).toBe('sk-1');
    expect(reencryptSecret(rewritten)).toBe(rewritten);
    // Even before the format gate opens: re-encryption runs only after it.
    expect(isCurrentCiphertext(reencryptSecret(v010Encrypt('sk-2', OLD)))).toBe(true);

    // The old key is no longer needed for it.
    keys.previous = undefined;
    expect(decryptSecret(rewritten)).toBe('sk-1');
  });

  it('fails clearly when the key a value needs is not configured', () => {
    keys.current = OLD;
    const versioned = encryptSecretVersioned('sk-1');
    const legacy = v010Encrypt('sk-1', OLD);
    keys.current = CURRENT;

    expect(() => decryptSecret(versioned)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(versioned)).toThrow(
      `encrypted with key ${encryptionKeyId(OLD)}, which is neither ENCRYPTION_KEY nor in ENCRYPTION_KEYS_PREVIOUS`,
    );
    expect(() => decryptSecret(legacy)).toThrow(/Add that key to ENCRYPTION_KEYS_PREVIOUS/);
    keys.previous = OLDER;
    expect(() => decryptSecret(legacy)).toThrow(
      /does not decrypt with ENCRYPTION_KEY or any of the 1 key\(s\)/,
    );
  });

  it('refuses a damaged versioned value rather than trying other keys', () => {
    const value = encryptSecretVersioned('sk-1');
    const damaged = `${value.slice(0, -4)}AAAA`;
    expect(() => decryptSecret(damaged)).toThrow(/damaged/);
    expect(() => decryptSecret(`${CIPHERTEXT_PREFIX}:x`)).toThrow(SecretDecryptionError);
    expect(ciphertextKeyId(`${CIPHERTEXT_PREFIX}no-separator`)).toBe('');
    expect(() => decryptSecret(`${CIPHERTEXT_PREFIX}no-separator`)).toThrow(/key \(none\)/);
    expect(() => decryptSecret(`${CIPHERTEXT_PREFIX}${encryptionKeyId(CURRENT)}:AAAA`)).toThrow(
      /too short/,
    );
  });

  it('ignores the current key or a duplicate listed as previous', () => {
    keys.previous = `${CURRENT},${OLD},${OLD}`;
    expect(encryptionKeyIds().previous).toEqual([encryptionKeyId(OLD)]);
    expect(parsePreviousKeys(' a , ,b ')).toEqual(['a', 'b']);
    expect(parsePreviousKeys(undefined)).toEqual([]);
  });

  it('validates ENCRYPTION_KEYS_PREVIOUS at start-up', () => {
    const base = {
      DATABASE_URL: 'postgres://x',
      AUTH_SECRET: 'a'.repeat(32),
      ENCRYPTION_KEY: CURRENT,
    };
    expect(
      parseEnv({ ...base, ENCRYPTION_KEYS_PREVIOUS: `${OLD}, ${OLDER}` }).ENCRYPTION_KEYS_PREVIOUS,
    ).toBe(`${OLD}, ${OLDER}`);
    expect(() => parseEnv({ ...base, ENCRYPTION_KEYS_PREVIOUS: `${OLD},short` })).toThrow(
      /ENCRYPTION_KEYS_PREVIOUS must be at least 32 characters/,
    );
  });
});

describe('unit: encrypted values inside instance settings', async () => {
  const { encryptedJsonValues, reencryptJson } = await import('@oci/db');
  const settings = {
    driver: 's3',
    s3: { bucket: 'b', encryptedSecretAccessKey: 'old-1', encryptedSecretKey: 'old-2' },
    encryptedApiKey: 'oci:v1:current:x',
    encryptedFallbackApiKey: null,
    encryptedPassword: '',
    list: [{ encryptedToken: 'old-3' }],
    encryption: 'not a secret',
  };

  it('finds every encrypted field, nested or in lists', () => {
    expect(encryptedJsonValues(settings).sort()).toEqual(
      ['oci:v1:current:x', 'old-1', 'old-2', 'old-3'].sort(),
    );
  });

  it('rewrites only values not already current, and reports none changed when all are', () => {
    const paths: string[] = [];
    const result = reencryptJson(
      settings,
      (secret, path) => {
        paths.push(path);
        return `new:${secret}`;
      },
      (secret) => secret.startsWith('oci:v1:current:'),
    );
    expect(result?.changed).toBe(3);
    expect(paths.sort()).toEqual(
      ['list[0].encryptedToken', 's3.encryptedSecretAccessKey', 's3.encryptedSecretKey'].sort(),
    );
    expect(result?.value).toMatchObject({
      s3: { bucket: 'b', encryptedSecretAccessKey: 'new:old-1' },
      encryptedApiKey: 'oci:v1:current:x',
      encryption: 'not a secret',
    });
    expect(
      reencryptJson(
        result?.value,
        () => 'x',
        () => true,
      ),
    ).toBeNull();
  });
});
