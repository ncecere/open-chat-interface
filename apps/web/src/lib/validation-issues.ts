/**
 * Turns the field-level details of an API validation error into sentences an
 * administrator can act on ("Label must be at most 80 characters"), instead of
 * the bare "Request validation failed". The API sends Zod issues (`path`,
 * `code`, bounds) or its own `{ path, message }` pairs; anything else is
 * ignored.
 */
interface Issue {
  path?: unknown;
  message?: unknown;
  code?: unknown;
  origin?: unknown;
  format?: unknown;
  maximum?: unknown;
  minimum?: unknown;
}

const MAX_SHOWN = 6;

function fieldName(path: unknown): string | null {
  if (!Array.isArray(path) || path.length === 0) return null;
  const name = [...path].reverse().find((part): part is string => typeof part === 'string');
  if (!name) return null;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\burl\b/g, 'URL')
    .replace(/\bapi\b/g, 'API')
    .replace(/\bsmtp\b/g, 'SMTP');
  const item = path.find((part) => typeof part === 'number');
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return typeof item === 'number' ? `${label} (item ${item + 1})` : label;
}

const amount = (value: unknown) =>
  typeof value === 'number' ? value.toLocaleString('en-US') : String(value);

function describe(issue: Issue): string | null {
  const { code, origin, maximum, minimum, format } = issue;
  if (code === 'too_big') {
    if (origin === 'string') return `must be at most ${amount(maximum)} characters`;
    if (origin === 'array') return `can have at most ${amount(maximum)} items`;
    return `must be at most ${amount(maximum)}`;
  }
  if (code === 'too_small') {
    if (origin === 'string')
      return minimum === 1 ? 'is required' : `must be at least ${amount(minimum)} characters`;
    if (origin === 'array') return `needs at least ${amount(minimum)}`;
    return `must be at least ${amount(minimum)}`;
  }
  if (code === 'invalid_format') {
    if (format === 'email') return 'must be a valid email address';
    if (format === 'url') return 'must be a valid URL';
    if (format === 'regex') return 'contains characters that are not allowed';
  }
  if (code === 'invalid_type') return 'is missing or not the right kind of value';
  return typeof issue.message === 'string' && issue.message ? issue.message : null;
}

export function describeValidationIssues(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const sentences = details.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const issue = raw as Issue;
    const text = describe(issue);
    if (!text) return [];
    const field = fieldName(issue.path);
    // The API's own messages are already sentences ("An API key is required").
    const own = !issue.code && typeof issue.message === 'string';
    if (!field) return [text];
    return [own ? `${field}: ${text}` : `${field} ${text}.`];
  });
  return [...new Set(sentences)].slice(0, MAX_SHOWN);
}
