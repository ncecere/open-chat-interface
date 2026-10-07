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
  expected?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  inclusive?: unknown;
}

/**
 * Zod's built-in messages ("Too big: expected number to be <=8760", and in a
 * production bundle, where its English locale is tree-shaken away, just
 * "Invalid input"). These are reworded from the issue's code; any other
 * message was written by the schema's author and is kept as it is (#127).
 */
const ZOD_DEFAULT = /^(Invalid|Too (big|small)|Unrecognized|Expected|Required\b)/;

const MAX_SHOWN = 6;

/**
 * The form's own name for a field, keyed by the API's name for it, so an
 * error says "Short name", as the form does, rather than "Slug" (#127).
 */
export type FieldLabels = Readonly<Record<string, string>>;

function fieldName(path: unknown, labels: FieldLabels = {}): string | null {
  const name = fieldKey(path);
  if (!name || !Array.isArray(path)) return null;
  const words =
    labels[name] ??
    name
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

/**
 * What kind of value was expected, in words: "is missing or not the right
 * kind of value" gave no hint what to enter (#347), as for a whole number of
 * days typed with a decimal point.
 */
function invalidTypeText(issue: Issue): string {
  // Zod's own wording says when nothing was sent; a production bundle has none.
  if (typeof issue.message === 'string' && /received (undefined|null)\b/.test(issue.message))
    return 'is required';
  switch (issue.expected) {
    case 'int':
      return 'must be a whole number';
    case 'number':
      return 'must be a number';
    case 'string':
      return 'must be text';
    case 'boolean':
      return 'must be on or off';
    case 'array':
      return 'must be a list';
    default:
      return 'is missing or not the right kind of value';
  }
}

function describe(issue: Issue): string | null {
  const { code, origin, maximum, minimum, format } = issue;
  // `.positive()` is "more than 0", not "at least 0" (#127).
  const exclusive = issue.inclusive === false;
  if (code === 'too_big') {
    if (origin === 'string') return `must be at most ${amount(maximum)} characters`;
    if (origin === 'array') return `can have at most ${amount(maximum)} items`;
    return `must be ${exclusive ? 'less than' : 'at most'} ${amount(maximum)}`;
  }
  if (code === 'too_small') {
    if (origin === 'string')
      return minimum === 1 ? 'is required' : `must be at least ${amount(minimum)} characters`;
    if (origin === 'array') return `needs at least ${amount(minimum)}`;
    return `must be ${exclusive ? 'more than' : 'at least'} ${amount(minimum)}`;
  }
  if (code === 'invalid_format') {
    if (format === 'email') return 'must be a valid email address';
    if (format === 'url') return 'must be a valid URL';
    if (format === 'regex') return 'contains characters that are not allowed';
  }
  if (code === 'invalid_type') return invalidTypeText(issue);
  if (code === 'invalid_value') return 'is not one of the allowed choices';
  // Only Zod's own wording reaches here; it reads badly after a field name.
  return code ? 'is not valid' : null;
}

export function describeValidationIssues(details: unknown, labels?: FieldLabels): string[] {
  return [...new Set(validationProblems(details, labels).map(({ text }) => text))].slice(
    0,
    MAX_SHOWN,
  );
}

/** The API's name for the field an issue is about: the innermost named part of its path. */
function fieldKey(path: unknown): string | null {
  if (!Array.isArray(path)) return null;
  return [...path].reverse().find((part): part is string => typeof part === 'string') ?? null;
}

/**
 * Each issue's sentence with the field it is about (the API's name for it),
 * so a form can keep the sentences about fields not yet corrected (#257).
 */
export function validationProblems(
  details: unknown,
  labels?: FieldLabels,
): Array<{ field: string | null; text: string }> {
  if (!Array.isArray(details)) return [];
  return details.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const issue = raw as Issue;
    const key = fieldKey(issue.path);
    const sentence = issueSentence(issue, labels);
    return sentence ? [{ field: key, text: sentence }] : [];
  });
}

function issueSentence(issue: Issue, labels?: FieldLabels): string | null {
  const field = fieldName(issue.path, labels);
  // The API's own messages, and those a schema gives a refine or regex, are
  // already sentences ("An API key is required", "Use an IANA time zone
  // such as", "Use up to 24 lowercase letters").
  const own =
    typeof issue.message === 'string' &&
    issue.message &&
    (!issue.code || !ZOD_DEFAULT.test(issue.message))
      ? issue.message
      : null;
  if (own) return field ? `${field}: ${own}` : own;
  const text = describe(issue);
  if (!text) return null;
  // "must be at most 80" means nothing without the field it belongs to.
  if (!field) return null;
  return `${field} ${text}.`;
}

/**
 * One line for a failed check: the field-level reasons in `details` (an API
 * error's details, or a form's own Zod issues) when there are any, else
 * `message`. Forms that keep their error as text need this: for a validation
 * failure the API's message is only "Request validation failed" (#127).
 */
export function validationText(details: unknown, message: string, labels?: FieldLabels): string {
  const issues = describeValidationIssues(details, labels);
  return issues.length > 0 ? issues.join(' ') : message;
}
