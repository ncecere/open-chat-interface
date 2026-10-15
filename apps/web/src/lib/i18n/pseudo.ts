import { type MessageNode, parseMessage } from './message-parse';

/**
 * Pseudo-locales, made from `en.json` when they are chosen (nothing to
 * commit or keep in step):
 *
 * - `en-XA`: every letter accented, text about 40% longer, the whole message in
 *   square brackets. Untranslated text shows as plain English between the
 *   accented words, a clipped label shows as a missing `]`, and a layout that
 *   only fits English breaks.
 * - `ar-XB`: the English text in right-to-left runs, so the page is mirrored
 *   (together with `dir="rtl"`) without needing Arabic readers to find the
 *   problems.
 *
 * Only the literal text is changed. Arguments, plurals and `#` are kept, so a
 * pseudo message formats exactly like the English one.
 */
export type PseudoKind = 'en-XA' | 'ar-XB';

const ACCENTS: Record<string, string> = {
  a: 'å',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'î',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ø',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ü',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
};

const RLO = '\u202E';
const PDF = '\u202C';

function accent(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = ACCENTS[lower];
    out += mapped ? (ch === lower ? mapped : mapped.toUpperCase()) : ch;
  }
  // About 40% longer. The padding is `·` marks, which never read as a word.
  return out + '·'.repeat(Math.ceil(text.length * 0.4));
}

function transformText(text: string, kind: PseudoKind): string {
  if (!text.trim()) return text;
  return kind === 'en-XA' ? accent(text) : `${RLO}${text}${PDF}`;
}

/** Text written so the message parser reads it back as the same text. */
function escapeText(text: string, inPlural: boolean): string {
  let out = '';
  for (const ch of text) {
    if (ch === "'") out += "''";
    else if (ch === '{' || ch === '}') out += `'${ch}'`;
    else if (ch === '#' && inPlural) out += "'#'";
    else out += ch;
  }
  return out;
}

function emit(nodes: readonly MessageNode[], kind: PseudoKind, inPlural: boolean): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += escapeText(transformText(node, kind), inPlural);
      continue;
    }
    switch (node.type) {
      case 'pound':
        out += '#';
        break;
      case 'arg':
        out += `{${node.name}}`;
        break;
      case 'number':
        out += `{${node.name}, number${node.style === 'decimal' ? '' : `, ${node.style}`}}`;
        break;
      case 'date':
        out += `{${node.name}, date, ${node.style}}`;
        break;
      case 'plural': {
        const branches = Object.entries(node.branches)
          .map(([selector, body]) => `${selector} {${emit(body, kind, true)}}`)
          .join(' ');
        out += `{${node.name}, plural, ${node.offset ? `offset:${node.offset} ` : ''}${branches}}`;
        break;
      }
    }
  }
  return out;
}

/** One message in a pseudo-locale; a message that does not parse is returned as it is. */
export function pseudoMessage(message: string, kind: PseudoKind): string {
  let nodes: MessageNode[];
  try {
    nodes = parseMessage(message);
  } catch {
    return message;
  }
  const body = emit(nodes, kind, false);
  return kind === 'en-XA' ? `[${body}]` : body;
}

export function pseudoCatalog(
  source: Readonly<Record<string, string>>,
  kind: PseudoKind,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).map(([key, message]) => [key, pseudoMessage(message, kind)]),
  );
}
