/**
 * The Windows-1252 (Western European) repertoire of the PDF standard fonts,
 * Helvetica and Courier, which are not embedded. Documents within it keep
 * using them (small files, as before v0.10); see pdf-text.ts for the rest.
 */

const WIN_ANSI_EXTRA = new Set([
  0x152, 0x153, 0x160, 0x161, 0x178, 0x17d, 0x17e, 0x192, 0x2c6, 0x2dc, 0x2013, 0x2014, 0x2018,
  0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a,
  0x20ac, 0x2122,
]);

export const STAND_INS: Record<string, string> = {
  '\u2190': '<-',
  '\u2192': '->',
  '\u2194': '<->',
  '\u21d0': '<=',
  '\u21d2': '=>',
  '\u2212': '-',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2015': '-',
  '\u2264': '<=',
  '\u2265': '>=',
  '\u2260': '!=',
  '\u2248': '~',
  '\u2032': "'",
  '\u2033': '"',
  '\u2009': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u202f': ' ',
  '\u200b': '',
  '\u200c': '',
  '\u200d': '',
  '\ufeff': '',
  '\u2713': 'v',
  '\u2714': 'v',
  '\u2717': 'x',
  '\u2718': 'x',
  '\u25cf': '\u2022',
  '\u25e6': '\u2022',
  '\u25aa': '\u2022',
};

export function winAnsi(code: number): boolean {
  return (
    (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code)
  );
}

/** Text the standard fonts can draw: see the module comment. */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0)!;
    if (char === '\n') out += char;
    else if (char === '\t') out += '    ';
    else if (winAnsi(code)) out += char;
    else if (STAND_INS[char] !== undefined) out += STAND_INS[char];
    else {
      const base = char.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
      out += base && [...base].every((part) => winAnsi(part.codePointAt(0)!)) ? base : '?';
    }
  }
  return out;
}
