/**
 * Field names whose values must never reach the audit log.
 *
 * Matched as a substring against the lower-cased key, so `clientSecret`,
 * `encryptedApiKey`, and `smtpPassword` are all caught without listing every
 * spelling. A recorded change says a secret changed, never what it became.
 */
const SECRET_FRAGMENTS = ['password', 'secret', 'apikey', 'credential', 'privatekey'];

/**
 * `token` in the singular (`accessToken`, `botToken`); `tokens` is a count
 * (`maxOutputTokens`, `tokensPerMinute`), which an audit entry should show
 * as it was and became (#221).
 */
const TOKEN = /token(?!s)/;

function isSecret(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_FRAGMENTS.some((fragment) => lowered.includes(fragment)) || TOKEN.test(lowered);
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
        before: redactedSecret(previous),
        after: redactedSecret(next),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length > 0
  );
}

/** Nested plain objects as dotted paths (`roles.user.chatRequestsPerMinute`). */
function flatten(value: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry)) Object.assign(out, flatten(entry, path));
    else out[path] = entry instanceof Date ? entry.toISOString() : entry;
  }
  return out;
}

/**
 * What an update changed, as each value was and became: the one helper for
 * an entry that should answer "and what was it before" (#221, #258).
 *
 * `before` and `after` are the values as saved before and after, with any
 * nested object in full; only `after`'s keys are compared (or only `keys`, to
 * leave out columns such as encrypted secrets and timestamps). Nested objects
 * are compared field by field and named by path, so raising one role's limit
 * records that limit, not two whole copies of every role's, and a field a
 * nested object no longer has is recorded as becoming null. Dates are
 * compared and recorded as ISO strings; secrets as `[set]`/`[unset]`, as in
 * `diffSettings`.
 */
export function diffUpdate(
  before: object | null | undefined,
  after: object,
  keys?: readonly string[],
): SettingChange[] {
  const pick = (value: object) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => !keys || keys.includes(key)),
    ) as Record<string, unknown>;
  const next = pick(after);
  const previous = flatten(pick(before ?? {}));
  const flat = flatten(next);
  for (const path of Object.keys(previous)) {
    const top = path.split('.')[0] as string;
    if (path !== top && !(path in flat) && top in next) flat[path] = null;
  }
  return diffSettings(previous, flat);
}

/**
 * Recursively strips secret-looking values from a nested settings object,
 * for the branches that arrive as one object rather than as flat keys.
 */
const REDACTED = new Set(['[set]', '[unset]']);

/** Presence only. Already-redacted markers stay as they are, so redacting twice is safe. */
function redactedSecret(entry: unknown): string {
  if (typeof entry === 'string' && REDACTED.has(entry)) return entry;
  return entry ? '[set]' : '[unset]';
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSecret(key) ? redactedSecret(entry) : redactSecrets(entry),
    ]),
  );
}
