/**
 * File names made from a title (#361). Letters and digits of every script are
 * kept: a Japanese, Arabic or Russian conversation must not download as
 * "conversation-….md". Only what a file system or a header cannot carry is
 * removed.
 */

/** Names Windows will not create, whatever the extension. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** U+200C (zero-width non-joiner) is part of ordinary Persian and Urdu words. */
const KEPT = /[^\p{L}\p{N}\p{M}\u200c\s_-]/gu;

const DEFAULT_MAX_CHARACTERS = 60;

/**
 * A stem for a file name: lower-cased, words joined by hyphens, at most `max`
 * characters (never half a surrogate pair), and `fallback` when nothing is
 * left. Slashes, quotes, dots, control and bidirectional-override characters,
 * emoji and other symbols are removed, so the result is a single valid name on
 * every common file system. The caller adds its own date or extension.
 */
export function safeFileStem(
  title: string,
  fallback = 'file',
  max = DEFAULT_MAX_CHARACTERS,
): string {
  const words = title
    .normalize('NFC')
    .replace(KEPT, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const stem = Array.from(words.toLowerCase()).slice(0, max).join('').replace(/-+$/, '');
  if (!stem) return fallback;
  return RESERVED_NAMES.test(stem) ? `${stem}-` : stem;
}

/** RFC 5987 `attr-char`: what `filename*` may carry without a percent escape. */
const encodeExtended = (value: string) =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The plain `filename` for clients that ignore `filename*`: printable ASCII only. */
function asciiFallback(filename: string): string {
  const ascii = filename
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7e]|["\\%;/]/g, '_')
    .replace(/_{2,}/g, '_')
    .trim();
  const extension = /\.[A-Za-z0-9]{1,12}$/.exec(ascii)?.[0] ?? '';
  const stem = extension ? ascii.slice(0, -extension.length) : ascii;
  // With no ASCII letter left, what remains is only digits and underscores.
  return /[A-Za-z]/.test(stem) ? ascii : `download${extension}`;
}

/**
 * A `Content-Disposition` value that names the file exactly (`filename*`,
 * RFC 5987/6266, UTF-8) and gives an ASCII `filename` for old clients.
 */
export function contentDisposition(
  filename: string,
  type: 'attachment' | 'inline' = 'attachment',
): string {
  const clean = filename.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '').replace(/[/\\]/g, '_');
  return `${type}; filename="${asciiFallback(clean)}"; filename*=UTF-8''${encodeExtended(clean)}`;
}
