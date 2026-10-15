/**
 * The message syntax of the catalogs: a small subset of ICU MessageFormat.
 *
 *   Hello {name}                                  an argument
 *   {n, number}  {n, number, percent|integer}     a number in the locale
 *   {d, date, short|long|time}                    a date or time in the locale
 *   {count, plural, one {# file} other {# files}} a plural; `#` is the count
 *   {n, plural, offset:1 =0 {..} one {..} ...}    exact matches and an offset
 *
 * Apostrophes follow ICU's "double optional" rule: `''` is one apostrophe,
 * `'{` or `'}` starts quoted text that ends at the next `'`, and any other
 * apostrophe is plain text, so "It's" needs no escaping.
 *
 * This file imports nothing and uses only syntax Node can strip, because
 * `scripts/check-i18n.mjs` loads it to compare a locale with English.
 */

export type NumberStyle = 'decimal' | 'percent' | 'integer';
export type DateStyle = 'short' | 'long' | 'time';

export type MessageNode =
  | string
  | { type: 'arg'; name: string }
  | { type: 'number'; name: string; style: NumberStyle }
  | { type: 'date'; name: string; style: DateStyle }
  | { type: 'pound' }
  | {
      type: 'plural';
      name: string;
      offset: number;
      /** Keyed by `zero|one|two|few|many|other` or `=N`. */
      branches: Record<string, MessageNode[]>;
    };

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const NUMBER_STYLES = ['decimal', 'percent', 'integer'];
const DATE_STYLES = ['short', 'long', 'time'];

export class MessageSyntaxError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} (at ${offset})`);
    this.name = 'MessageSyntaxError';
  }
}

const NAME = /[A-Za-z0-9_]/;
const MAX_DEPTH = 8;

class Parser {
  private pos = 0;
  private readonly source: string;

  // No parameter properties: Node strips types but does not compile those.
  constructor(source: string) {
    this.source = source;
  }

  parse(): MessageNode[] {
    const nodes = this.nodes(0, false);
    if (this.pos < this.source.length) this.fail('Unmatched }');
    return nodes;
  }

  private fail(message: string): never {
    throw new MessageSyntaxError(message, this.pos);
  }

  private skipSpace(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos] ?? '')) this.pos++;
  }

  private nodes(depth: number, inPlural: boolean): MessageNode[] {
    const out: MessageNode[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push(text);
      text = '';
    };
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos] as string;
      if (ch === '}') {
        if (depth === 0) this.fail('Unmatched }');
        break;
      }
      if (ch === '{') {
        flush();
        out.push(this.argument(depth));
        continue;
      }
      if (ch === '#' && inPlural) {
        flush();
        out.push({ type: 'pound' });
        this.pos++;
        continue;
      }
      if (ch === "'") {
        const next = this.source[this.pos + 1];
        if (next === "'") {
          text += "'";
          this.pos += 2;
        } else if (next === '{' || next === '}' || (next === '#' && inPlural)) {
          // Quoted text, up to the next lone apostrophe.
          this.pos++;
          while (this.pos < this.source.length) {
            const c = this.source[this.pos] as string;
            if (c === "'") {
              if (this.source[this.pos + 1] === "'") {
                text += "'";
                this.pos += 2;
                continue;
              }
              this.pos++;
              break;
            }
            text += c;
            this.pos++;
          }
        } else {
          text += "'";
          this.pos++;
        }
        continue;
      }
      text += ch;
      this.pos++;
    }
    flush();
    return out;
  }

  private word(what: string): string {
    const start = this.pos;
    while (this.pos < this.source.length && NAME.test(this.source[this.pos] as string)) this.pos++;
    if (this.pos === start) this.fail(`Expected ${what}`);
    return this.source.slice(start, this.pos);
  }

  private argument(depth: number): MessageNode {
    if (depth >= MAX_DEPTH) this.fail('Nested too deeply');
    this.pos++; // {
    this.skipSpace();
    const name = this.word('an argument name');
    this.skipSpace();
    if (this.source[this.pos] === '}') {
      this.pos++;
      return { type: 'arg', name };
    }
    if (this.source[this.pos] !== ',') this.fail('Expected , or }');
    this.pos++;
    this.skipSpace();
    const type = this.word('an argument type');
    this.skipSpace();

    if (type === 'number' || type === 'date') {
      let style: string | undefined;
      if (this.source[this.pos] === ',') {
        this.pos++;
        this.skipSpace();
        style = this.word('a style');
        this.skipSpace();
      }
      if (this.source[this.pos] !== '}') this.fail('Expected }');
      this.pos++;
      if (type === 'number') {
        const resolved = style ?? 'decimal';
        if (!NUMBER_STYLES.includes(resolved)) this.fail(`Unknown number style ${resolved}`);
        return { type: 'number', name, style: resolved as NumberStyle };
      }
      const resolved = style ?? 'short';
      if (!DATE_STYLES.includes(resolved)) this.fail(`Unknown date style ${resolved}`);
      return { type: 'date', name, style: resolved as DateStyle };
    }

    if (type === 'plural') return this.plural(name, depth);
    return this.fail(`Unknown argument type ${type}`);
  }

  private plural(name: string, depth: number): MessageNode {
    if (this.source[this.pos] !== ',') this.fail('Expected , after plural');
    this.pos++;
    this.skipSpace();
    let offset = 0;
    if (this.source.startsWith('offset:', this.pos)) {
      this.pos += 'offset:'.length;
      this.skipSpace();
      offset = Number(this.word('an offset'));
      if (!Number.isInteger(offset) || offset < 0) this.fail('Bad offset');
      this.skipSpace();
    }
    const branches: Record<string, MessageNode[]> = {};
    while (this.pos < this.source.length && this.source[this.pos] !== '}') {
      let selector: string;
      if (this.source[this.pos] === '=') {
        this.pos++;
        selector = `=${this.word('a number')}`;
        if (!/^=\d+$/.test(selector)) this.fail('Bad exact selector');
      } else {
        selector = this.word('a plural category');
        if (!(PLURAL_CATEGORIES as readonly string[]).includes(selector))
          this.fail(`Unknown plural category ${selector}`);
      }
      if (selector in branches) this.fail(`Duplicate branch ${selector}`);
      this.skipSpace();
      if (this.source[this.pos] !== '{') this.fail('Expected {');
      this.pos++;
      branches[selector] = this.nodes(depth + 1, true);
      if (this.source[this.pos] !== '}') this.fail('Expected }');
      this.pos++;
      this.skipSpace();
    }
    if (this.source[this.pos] !== '}') this.fail('Unterminated plural');
    this.pos++;
    if (!branches.other) this.fail('A plural needs an other branch');
    return { type: 'plural', name, offset, branches };
  }
}

/** Parses a message; throws `MessageSyntaxError` when it is not valid. */
export function parseMessage(message: string): MessageNode[] {
  return new Parser(message).parse();
}

export interface MessageArg {
  name: string;
  type: 'arg' | 'number' | 'date' | 'plural';
}

export interface MessageDescription {
  /** Every argument, once, sorted by name (`plural` wins over a repeat of the same name). */
  args: MessageArg[];
  /** For each plural, the categories it has (`=N` selectors left out), in CLDR order. */
  plurals: Record<string, string[]>;
}

function collect(
  nodes: MessageNode[],
  args: Map<string, MessageArg>,
  plurals: Map<string, string[]>,
) {
  for (const node of nodes) {
    if (typeof node === 'string' || node.type === 'pound') continue;
    const known = args.get(node.name);
    if (!known || known.type === 'arg') args.set(node.name, { name: node.name, type: node.type });
    if (node.type === 'plural') {
      plurals.set(
        node.name,
        PLURAL_CATEGORIES.filter((category) => category in node.branches),
      );
      for (const branch of Object.values(node.branches)) collect(branch, args, plurals);
    }
  }
}

/** What a message uses, for comparing a translation with the English source. */
export function describeMessage(message: string): MessageDescription {
  const args = new Map<string, MessageArg>();
  const plurals = new Map<string, string[]>();
  collect(parseMessage(message), args, plurals);
  return {
    args: [...args.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    plurals: Object.fromEntries(plurals),
  };
}
