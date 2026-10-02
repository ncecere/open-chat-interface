/**
 * Small text helpers shared by search, tools and prompts. Kept here so the
 * escaping rules that keep search safe exist in exactly one place.
 */

/** Removes control characters (including the search highlight markers) from stored or typed text. */
export function stripControls(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
}

/**
 * Quotes a lexeme as a tsquery operand, optionally as a prefix (`plan:*`).
 * Lexemes must come from Postgres's own parser, never from raw input.
 */
export function tsqueryOperand(lexeme: string, prefix: boolean): string {
  const quoted = `'${lexeme.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
  return prefix ? `${quoted}:*` : quoted;
}

/** Shortens text to at most `max` characters, ending with an ellipsis when cut. */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** A name on one line, as it should appear quoted in a prompt. */
export function singleLine(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}
