/**
 * What a log line may carry (#264): identifiers and causes, never the values
 * a query was run with.
 *
 * Drizzle wraps every failed query in a DrizzleQueryError whose `params` are
 * the values bound to it, and whose message (so also its stack, and anything
 * that stringifies it) ends in `params: <the same values>`. Those values are
 * conversation text (the reply being saved), session tokens (Better Auth's
 * session lookup), passwords' hashes, API keys: during a database outage every
 * failing request logged its own. Redacting at the logger, rather than at
 * each call site, covers every path at once: an error passed as `err` or
 * `error`, nested in a `cause` chain or an array, or already turned into a
 * string with `error.message` or `String(error)`.
 */

/**
 * Properties of an error that hold values rather than causes: Drizzle's
 * `params`; postgres.js's `parameters` and `args` (enumerable in its debug
 * mode); PostgreSQL's `detail`, which repeats row values ("Key (email)=(...)
 * already exists"); and the AI SDK's `requestBodyValues` (the prompt sent to
 * a provider). The constraint, table and column names stay.
 */
const VALUE_KEYS: ReadonlySet<string> = new Set([
  'params',
  'parameters',
  'args',
  'detail',
  'requestBodyValues',
]);

/** Long statements are cut: the start names the table and the operation. */
const QUERY_LIMIT = 500;
const MAX_DEPTH = 8;

const PARAMS_MARKER = '\nparams: ';
export const REDACTED = '[redacted]';

/**
 * Removes the parameter values from a DrizzleQueryError's text
 * ("Failed query: <statement>\nparams: <values>"). The values run to the end
 * of the text and may themselves hold newlines, so everything after the
 * marker goes.
 */
export function redactLogText(text: string): string {
  const at = text.indexOf(PARAMS_MARKER);
  if (at === -1 || !text.includes('Failed query: ')) return text;
  return `${text.slice(0, at)}${PARAMS_MARKER}${REDACTED}`;
}

/**
 * An error's message without parameter values, for text that is stored and
 * shown (a job run's error, a failed backup's reason): those rows outlive the
 * retention and deletion of the content a failed query was saving.
 */
export function errorText(error: unknown): string {
  return redactLogText(error instanceof Error ? error.message : String(error));
}

function shortenQuery(query: string): string {
  return query.length > QUERY_LIMIT ? `${query.slice(0, QUERY_LIMIT)}…` : query;
}

/**
 * Errors already redacted. pino's `err` serializer runs on what
 * `formatters.log` produced, and running the text redaction twice would cut
 * the stack frames after the redacted parameters.
 */
const redactedErrors = new WeakSet<object>();

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const message = redactLogText(error.message);
  let stack: string | undefined;
  if (typeof error.stack === 'string') {
    // The stack starts with the message: swap in the redacted one exactly, so
    // the frames after it are kept even when the values held newlines.
    stack =
      message !== error.message && error.stack.includes(error.message)
        ? error.stack.replace(error.message, () => message)
        : redactLogText(error.stack);
  }
  const out: Record<string, unknown> = {
    type: error.constructor?.name ?? error.name,
    message,
    stack,
  };
  for (const key of Object.keys(error)) {
    if (key in out || key === 'cause') continue;
    const value = (error as unknown as Record<string, unknown>)[key];
    if (VALUE_KEYS.has(key)) {
      if (value !== undefined) out[key] = REDACTED;
    } else if (key === 'query' && typeof value === 'string') {
      out[key] = shortenQuery(value);
    } else {
      out[key] = redact(value, depth + 1, seen);
    }
  }
  // `cause` is not enumerable when set with `new Error(message, { cause })`.
  if (error.cause !== undefined) out.cause = redact(error.cause, depth + 1, seen);
  redactedErrors.add(out);
  return out;
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactLogText(value);
  if (!value || typeof value !== 'object' || redactedErrors.has(value)) return value;
  if (depth > MAX_DEPTH || seen.has(value)) return '[nested]';
  if (value instanceof Error) {
    seen.add(value);
    return redactError(value, depth, seen);
  }
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((item) => redact(item, depth + 1, seen));
  }
  // Dates, buffers and class instances are left to pino's own rendering.
  if (!isPlainObject(value)) return value;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = redact(item, depth + 1, seen);
  return out;
}

/**
 * A copy of a log value with every error turned into a plain, redacted
 * object (its type, message, stack, code and other causes, and its `cause`
 * chain) and every DrizzleQueryError text cut before its parameters.
 */
export function redactLogValue(value: unknown): unknown {
  return redact(value, 0, new WeakSet());
}

/** For pino's `formatters.log`. */
export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  return redactLogValue(object) as Record<string, unknown>;
}
