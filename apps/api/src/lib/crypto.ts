import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { loadEnv } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Stored secrets (provider keys, connector credentials and tokens, webhook
 * secrets, credentials in instance settings) are AES-256-GCM encrypted with a
 * key derived from `ENCRYPTION_KEY`.
 *
 * Two formats (v0.11 design, item 23; docs/OPERATIONS.md, "Rotating
 * ENCRYPTION_KEY"):
 *
 * - **Legacy** (every release before v0.11): `base64(iv | tag | ciphertext)`.
 *   No key is named; it is tried with `ENCRYPTION_KEY` and then each key in
 *   `ENCRYPTION_KEYS_PREVIOUS` (GCM's authentication tag rejects a wrong key,
 *   so a match is never a false one).
 * - **Versioned**: `oci:v1:<key id>:base64(iv | tag | ciphertext)`, where the
 *   key id is 12 hex characters of an HMAC of the key (it identifies a key
 *   without revealing it). Base64 never contains `:`, so the two cannot be
 *   confused.
 *
 * v0.10 replicas read only the legacy format, so v0.11 writes it, under the
 * current key, until every replica runs v0.11 (`setVersionedCiphertext`, from
 * services/encryption/format.ts once `migrate --post` has finished).
 */
export const CIPHERTEXT_PREFIX = 'oci:v1:';

interface Key {
  id: string;
  key: Buffer;
}

interface Keyring {
  source: string;
  current: Key;
  previous: Key[];
  byId: Map<string, Key>;
}

/** A value that cannot be decrypted with any configured key. */
export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

/** The key id written into versioned ciphertexts: not reversible to the key. */
export function encryptionKeyId(secret: string): string {
  return createHmac('sha256', secret).update('oci-encryption-key-id').digest('hex').slice(0, 12);
}

function deriveKey(secret: string): Key {
  return { id: encryptionKeyId(secret), key: createHash('sha256').update(secret).digest() };
}

/** `ENCRYPTION_KEYS_PREVIOUS` split into keys; blank entries are ignored. */
export function parsePreviousKeys(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

let keyring: Keyring | null = null;

function currentKeyring(): Keyring {
  const env = loadEnv();
  const source = `${env.ENCRYPTION_KEY}\u0000${env.ENCRYPTION_KEYS_PREVIOUS ?? ''}`;
  if (keyring?.source === source) return keyring;
  const current = deriveKey(env.ENCRYPTION_KEY);
  const byId = new Map<string, Key>([[current.id, current]]);
  const previous: Key[] = [];
  for (const secret of parsePreviousKeys(env.ENCRYPTION_KEYS_PREVIOUS)) {
    const key = deriveKey(secret);
    // The current key listed again, or a key listed twice: nothing to add.
    if (byId.has(key.id)) continue;
    byId.set(key.id, key);
    previous.push(key);
  }
  keyring = { source, current, previous, byId };
  return keyring;
}

/** The id of the key new values are encrypted with, and of every previous key. */
export function encryptionKeyIds(): { current: string; previous: string[] } {
  const ring = currentKeyring();
  return { current: ring.current.id, previous: ring.previous.map((key) => key.id) };
}

let versioned = false;

/**
 * Whether new values are written in the versioned format. Off until every
 * replica runs v0.11 (they could not read it otherwise).
 */
export function setVersionedCiphertext(enabled: boolean): void {
  versioned = enabled;
}

export function versionedCiphertextEnabled(): boolean {
  return versioned;
}

function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function open(body: string, key: Buffer): string {
  const raw = Buffer.from(body, 'base64');
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new SecretDecryptionError('The stored value is too short to be an encrypted secret');
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Encrypted in the versioned format under the current key, whatever the upgrade state. */
export function encryptSecretVersioned(plaintext: string): string {
  const { current } = currentKeyring();
  return `${CIPHERTEXT_PREFIX}${current.id}:${seal(plaintext, current.key)}`;
}

/**
 * Encrypts a secret for storage under the current `ENCRYPTION_KEY`: in the
 * versioned format once every replica runs v0.11, in the legacy format until
 * then.
 */
export function encryptSecret(plaintext: string): string {
  if (versioned) return encryptSecretVersioned(plaintext);
  return seal(plaintext, currentKeyring().current.key);
}

/** The key id a stored value names, or null for the legacy format. */
export function ciphertextKeyId(payload: string): string | null {
  if (!payload.startsWith(CIPHERTEXT_PREFIX)) return null;
  const end = payload.indexOf(':', CIPHERTEXT_PREFIX.length);
  return end === -1 ? '' : payload.slice(CIPHERTEXT_PREFIX.length, end);
}

/** True for a value in the versioned format under the current key. */
export function isCurrentCiphertext(payload: string): boolean {
  return ciphertextKeyId(payload) === currentKeyring().current.id;
}

/** The prefix every current value starts with (for counting in SQL). */
export function currentCiphertextPrefix(): string {
  return `${CIPHERTEXT_PREFIX}${currentKeyring().current.id}:`;
}

export function decryptSecret(payload: string): string {
  const ring = currentKeyring();
  const keyId = ciphertextKeyId(payload);
  if (keyId !== null) {
    const key = ring.byId.get(keyId);
    if (!key) {
      throw new SecretDecryptionError(
        `This value was encrypted with key ${keyId || '(none)'}, which is neither ENCRYPTION_KEY nor in ENCRYPTION_KEYS_PREVIOUS`,
      );
    }
    try {
      return open(payload.slice(CIPHERTEXT_PREFIX.length + keyId.length + 1), key.key);
    } catch (error) {
      if (error instanceof SecretDecryptionError) throw error;
      throw new SecretDecryptionError(
        `This value names key ${keyId} but does not decrypt with it: it is damaged`,
      );
    }
  }
  for (const key of [ring.current, ...ring.previous]) {
    try {
      return open(payload, key.key);
    } catch (error) {
      if (error instanceof SecretDecryptionError) throw error;
      // Authentication failed: not this key; try the next.
    }
  }
  throw new SecretDecryptionError(
    ring.previous.length > 0
      ? `This value does not decrypt with ENCRYPTION_KEY or any of the ${ring.previous.length} key(s) in ENCRYPTION_KEYS_PREVIOUS`
      : 'This value does not decrypt with ENCRYPTION_KEY (was it encrypted with an earlier key? Add that key to ENCRYPTION_KEYS_PREVIOUS)',
  );
}

/**
 * The value under the current key in the versioned format; a value already
 * current is returned as it is. Used by the background re-encryption, which
 * runs only once every replica reads the versioned format.
 */
export function reencryptSecret(payload: string): string {
  if (isCurrentCiphertext(payload)) return payload;
  return encryptSecretVersioned(decryptSecret(payload));
}

/** Last four characters of a credential, for display in the admin UI. */
export function credentialHint(secret: string): string {
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
