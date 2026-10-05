// Migration linter SQL text handling: parser loading, statement splitting, allow comments.

import { loadModule, parseSync } from 'libpg-query';

const BREAKPOINT = '--> statement-breakpoint';

let parserReady;
export async function loadParser() {
  parserReady ??= loadModule();
  await parserReady;
}

export function walk(node, visit) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node && typeof node === 'object') {
    visit(node);
    for (const value of Object.values(node)) walk(value, visit);
  }
}

/** Byte offsets from the parser to string offsets (files may contain UTF-8). */
function byteToCharMapper(text) {
  const buffer = Buffer.from(text, 'utf8');
  return (byteOffset) => buffer.subarray(0, byteOffset).toString('utf8').length;
}

/**
 * Splits a migration as Drizzle does (on `--> statement-breakpoint`), then
 * into individual statements with PostgreSQL's parser. Returns, per statement,
 * its text, the offset of its first token and its 1-based line.
 */
export function splitStatements(sql) {
  const statements = [];
  const errors = [];
  let chunkStart = 0;
  for (const chunk of sql.split(BREAKPOINT)) {
    const toChar = byteToCharMapper(chunk);
    let parsed;
    try {
      parsed = parseSync(chunk);
    } catch (error) {
      const firstToken = chunkStart + leadingSkip(chunk);
      errors.push({ offset: firstToken, message: error.message });
      chunkStart += chunk.length + BREAKPOINT.length;
      continue;
    }
    for (const entry of parsed.stmts ?? []) {
      const startByte = entry.stmt_location ?? 0;
      const start = toChar(startByte);
      const end = entry.stmt_len ? toChar(startByte + entry.stmt_len) : chunk.length;
      const raw = chunk.slice(start, end);
      const skip = leadingSkip(raw);
      statements.push({
        stmt: entry.stmt,
        text: raw.slice(skip).trim(),
        offset: chunkStart + start + skip,
      });
    }
    chunkStart += chunk.length + BREAKPOINT.length;
  }
  return { statements, errors };
}

/** Length of the whitespace and comments before a statement's first token. */
function leadingSkip(text) {
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const space = rest.match(/^\s+/);
    if (space) {
      index += space[0].length;
    } else if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      index += newline === -1 ? rest.length : newline + 1;
    } else if (rest.startsWith('/*')) {
      const close = rest.indexOf('*/');
      index += close === -1 ? rest.length : close + 2;
    } else {
      break;
    }
  }
  return index;
}

export function lineOf(text, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text.charCodeAt(index) === 10) line++;
  }
  return line;
}

const ALLOW_PATTERN = /^--\s*oci:lint-allow\b(.*)$/;

/**
 * `-- oci:lint-allow` comments in the run of comment lines directly above a
 * statement. A blank line or code ends the run; the breakpoint marker does not.
 */
export function allowCommentsAbove(sql, offset) {
  const lineStart = sql.lastIndexOf('\n', offset - 1) + 1;
  if (sql.slice(lineStart, offset).trim() !== '') return [];
  const lines = sql.slice(0, lineStart).split('\n');
  lines.pop(); // the empty string after the final newline
  const allows = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (line === BREAKPOINT) continue;
    if (!line.startsWith('--')) break;
    const match = line.match(ALLOW_PATTERN);
    if (!match) continue;
    const body = match[1].trim();
    const parsed = body.match(/^([a-z0-9-]+)\s*(?::\s*(.*))?$/);
    allows.push({
      line: index + 1,
      rule: parsed?.[1] ?? body,
      reason: (parsed?.[2] ?? '').trim(),
    });
  }
  return allows.reverse();
}
