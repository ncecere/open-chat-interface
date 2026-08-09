/**
 * Field names whose values must never reach the audit log.
 *
 * Matched as a substring against the lower-cased key, so `clientSecret`,
 * `encryptedApiKey`, and `smtpPassword` are all caught without listing every
 * spelling. A recorded change says a secret changed, never what it became.
 */
const SECRET_FRAGMENTS = ['password', 'secret', 'apikey', 'token', 'credential', 'privatekey'];

function isSecret(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

export interface SettingChange {
  key: string;
  before: unknown;
  after: unknown;
}

function comparable(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * What a settings update actually changed.
 *
 * Recording only the key names — which is what the audit log held before —
 * answers "somebody changed the sign-on settings" but not "what were they
 * before", which is the question asked when something has broken.
 *
 * Only keys present in the patch are compared: a partial update should not
 * report every untouched field as unchanged noise.
 */
export function diffSettings(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): SettingChange[] {
  const changes: SettingChange[] = [];

  for (const [key, next] of Object.entries(patch)) {
    if (next === undefined) continue;

    const previous = before[key];
    if (comparable(previous) === comparable(next)) continue;

    if (isSecret(key)) {
      // Presence is the useful fact: whether a secret was set, cleared, or
      // replaced. The value itself has no business being here.
      changes.push({
        key,
        before: previous ? '[set]' : '[unset]',
        after: next ? '[set]' : '[unset]',
      });
      continue;
    }

    // Redacted on both sides. A branch such as `smtp` arrives as a whole
    // object with a password inside it, so a key-level check alone lets the
    // value through in the patch even when the stored copy was cleaned.
    changes.push({
      key,
      before: previous === undefined ? null : redactSecrets(previous),
      after: redactSecrets(next),
    });
  }

  return changes;
}

/**
 * Recursively strips secret-looking values from a nested settings object,
 * for the branches that arrive as one object rather than as flat keys.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSecret(key) ? (entry ? '[set]' : '[unset]') : redactSecrets(entry),
    ]),
  );
}
