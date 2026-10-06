/** Honorifics an account name may start with; the greeting skips them. */
const TITLES = new Set(['dr', 'prof', 'professor', 'mr', 'mrs', 'ms', 'mx', 'miss', 'sir', 'dame']);

/**
 * The name the home page greets a person by (#315).
 *
 * The introduction asks "What should we call you?" and keeps the answer as the
 * `displayName` preference; the greeting used the first word of the account
 * name instead, so the first screen after the question ignored the answer. The
 * answer comes first; without one, the account name's given name: the part
 * after the comma of "Weber, Jonas", and not a leading title ("Dr Jane Doe").
 */
export function greetingName(
  accountName: string | null | undefined,
  displayName: string | null | undefined,
): string | undefined {
  const chosen = displayName?.trim();
  if (chosen) return chosen;
  const name = accountName?.trim() ?? '';
  const comma = name.indexOf(',');
  const given = comma >= 0 ? name.slice(comma + 1) : name;
  const words = given.split(/\s+/).filter(Boolean);
  const first = words.find((word) => !TITLES.has(word.toLowerCase().replace(/\.$/, '')));
  return first ?? words[0] ?? (comma > 0 ? name.slice(0, comma).trim() || undefined : undefined);
}
