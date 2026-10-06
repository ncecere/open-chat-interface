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
 * report every untouched field as unchanged noise. A branch that arrives as
 * an object (`storage`, `smtp`, `search`) is compared field by field and each
 * change is named by its path (`storage.maxFilesPerMessage`), with that
 * field's stored value as `before` (#344). Recording the whole stored branch
 * against only the fields sent made the reader find the one key inside a
 * long "before" and work out that nothing else had changed.
 */
export function diffSettings(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): SettingChange[] {
  const changes: SettingChange[] = [];

  for (const [key, next] of Object.entries(patch)) {
    if (next !== undefined) collectChange(key, before[key], next, changes);
  }

  return changes;
}

/**
 * A secret is sent under its own name (`password`, `apiKey`, `secretAccessKey`)
 * and stored encrypted under `encrypted<Name>`: what it was before is whichever
 * of the two the stored branch holds.
 */
function storedValue(container: unknown, key: string, secret: boolean): unknown {
  if (typeof container !== 'object' || container === null) return undefined;
  const stored = container as Record<string, unknown>;
  if (key in stored || !secret) return stored[key];
  return stored[`encrypted${key.charAt(0).toUpperCase()}${key.slice(1)}`];
}

function collectChange(path: string, previous: unknown, next: unknown, out: SettingChange[]) {
  // The whole path is checked, so a field under a secret-named branch
  // (`diffUpdate` hands over flattened paths) is redacted as well.
  if (isSecret(path)) {
    // Presence is the useful fact: whether a secret was set, cleared, or
    // replaced. The value itself has no business being here.
    if (comparable(previous) === comparable(next)) return;
    const was = redactedSecret(previous);
    const became = redactedSecret(next);
    // Sending no secret to a field that had none changes nothing.
    if (was === '[unset]' && became === '[unset]') return;
    out.push({ key: path, before: was, after: became });
    return;
  }

  // A branch sent as an object, over a stored branch that is one (or none
  // yet): compared field by field, so each change names its own path and its
  // own before. A secret inside it is read from its stored (encrypted) name.
  if (
    isPlainObject(next) &&
    (previous === undefined || previous === null || isObjectLike(previous))
  ) {
    for (const [key, entry] of Object.entries(next)) {
      if (entry === undefined) continue;
      collectChange(`${path}.${key}`, storedValue(previous, key, isSecret(key)), entry, out);
    }
    return;
  }

  if (comparable(previous) === comparable(next)) return;
  // Redacted on both sides, for a value holding secrets deeper than a key
  // check reaches (an array of objects, say).
  out.push({
    key: path,
    before: previous === undefined ? null : redactSecrets(previous),
    after: redactSecrets(next),
  });
}

function isObjectLike(value: unknown): boolean {
  return typeof value === 'object' && !Array.isArray(value) && value !== null;
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
