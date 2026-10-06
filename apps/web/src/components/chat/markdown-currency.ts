/**
 * Money is not maths (#339). The reply renderer reads `$…$` as inline maths
 * because models emit it, but remark-math closes at the *next* `$` with no
 * regard for what surrounds it, so "$5 for students, $10 for staff" became an
 * italic formula that lost both dollar signs. This applies the usual currency
 * rule (Pandoc's) before the text reaches the renderer: a `$` opens maths only
 * when a non-space follows it, and closes it only when a non-space precedes it
 * and no digit follows it. Every other single `$` is escaped (`\$`, which
 * Markdown shows as `$`), so it is typeset as typed.
 *
 * Kept as the maths the rule allows: `$x^2$`, `$2\pi r$`, `$$ … $$` display
 * maths (any `$$` run is left alone) and anything already written `\$`. Fenced
 * and inline code are never touched, and are masked while pairing so a code
 * span between two amounts cannot make them a formula.
 */
export function escapeCurrencyDollars(markdown: string): string {
  if (!markdown.includes('$')) return markdown;
  const masked = maskCode(markdown);
  const escaped: number[] = [];
  const end = masked.length;
  let i = 0;
  while (i < end) {
    const char = masked[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char !== '$') {
      i += 1;
      continue;
    }
    if (masked[i + 1] === '$') {
      // Display maths (or a stray run): its delimiters are not currency.
      while (masked[i] === '$') i += 1;
      continue;
    }
    const closer = opensMath(masked, i) ? findCloser(masked, i) : -1;
    if (closer === -1) {
      escaped.push(i);
      i += 1;
    } else {
      i = closer + 1;
    }
  }
  if (escaped.length === 0) return markdown;
  let result = '';
  let from = 0;
  for (const index of escaped) {
    result += `${markdown.slice(from, index)}\\`;
    from = index;
  }
  return result + markdown.slice(from);
}

/** The text with every code span and fence replaced by same-length filler. */
function maskCode(markdown: string): string {
  // An unclosed fence runs to the end: a reply is parsed while it streams.
  return markdown.replace(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g, (code) =>
    'x'.repeat(code.length),
  );
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/** A `$` opens maths when a non-space follows it. */
function opensMath(text: string, at: number): boolean {
  return !isSpace(text[at + 1]);
}

/**
 * The `$` that closes maths opened at `open`, or -1: the next unescaped `$` in
 * the same paragraph, if a non-space precedes it and no digit follows it. When
 * that one is not a closer (an amount, as in "$5 and $10"), the opener was
 * currency, and the `$` found gets its own turn as an opener.
 */
function findCloser(text: string, open: number): number {
  for (let j = open + 1; j < text.length; j++) {
    const char = text[j];
    if (char === '\\') {
      j += 1;
    } else if (char === '\n' && /^\n[ \t]*\n/.test(text.slice(j, j + 80))) {
      return -1;
    } else if (char === '$') {
      if (text[j + 1] === '$') return -1;
      return !isSpace(text[j - 1]) && !/\d/.test(text[j + 1] ?? '') ? j : -1;
    }
  }
  return -1;
}
