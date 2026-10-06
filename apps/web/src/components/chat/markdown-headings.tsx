import { type ComponentProps, createContext, type ReactNode, useContext } from 'react';
import { cn } from '~/lib/utils';

/**
 * Headings in Markdown below the page's own (#212, #271). The page's heading
 * (the conversation's or the share's title) is its one h1; a reply that began
 * "# Ten Facts About Owls" added a second, so screen-reader heading
 * navigation read the reply as a page of its own.
 *
 * Moving every level down by one still skipped levels: a reply that began
 * "### Quick example" was an h4 straight under the h1 (axe heading-order), and
 * one that went from ### to ##### skipped an h5. So the levels a message uses
 * are ranked: its largest becomes h2, the next h3, and so on, whichever
 * Markdown levels they were. Each keeps the size its Markdown level had, so
 * replies look the same, and `data-streamdown` keeps the Markdown level, as
 * Streamdown's own headings do.
 */
const SIZES = ['text-3xl', 'text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm'] as const;

/**
 * The Markdown heading levels the text being rendered uses, one bit per level
 * (bit 1 for #, ... bit 6 for ######). A number, so the headings re-render
 * only when the set changes, not on every streamed word. Null outside a
 * message: each level then moves down by one.
 */
export const HeadingLevels = createContext<number | null>(null);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** Lines that cannot be a setext heading's text (lists, tables, quotes' ends, rules). */
const NOT_SETEXT_TEXT = /^ {0,3}(?:[-*+]\s|\d+[.)]\s|#|\||>|$)|\|/;

/** Which heading levels `markdown` uses, as a bit set; code blocks are skipped. */
export function headingLevelsOf(markdown: string): number {
  let levels = 0;
  let fence: string | null = null;
  let previous = '';
  for (const raw of markdown.split('\n')) {
    // Headings inside block quotes count too.
    const line = raw.replace(/^(?: {0,3}> ?)+/, '');
    const fenceMark = FENCE.exec(line)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      previous = '';
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      previous = '';
      continue;
    }
    const atx = ATX.exec(line)?.[1];
    if (atx) levels |= 1 << atx.length;
    const setext = SETEXT.exec(line)?.[1];
    if (setext && previous && !NOT_SETEXT_TEXT.test(previous))
      levels |= 1 << (setext[0] === '=' ? 1 : 2);
    previous = line;
  }
  return levels;
}

/** The element level for Markdown `level`: one below the page's h1, then by rank. */
export function headingTagLevel(level: number, levels: number | null): number {
  if (levels === null) return Math.min(level + 1, 6);
  let above = 0;
  for (let larger = 1; larger < level; larger++) if (levels & (1 << larger)) above++;
  return Math.min(2 + above, 6);
}

type HeadingProps = ComponentProps<'h2'> & { node?: unknown; children?: ReactNode };

function demoted(level: 1 | 2 | 3 | 4 | 5 | 6) {
  function Heading({ node: _node, className, children, ...props }: HeadingProps) {
    const levels = useContext(HeadingLevels);
    const Tag = `h${headingTagLevel(level, levels)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
    return (
      <Tag
        className={cn('mt-6 mb-2 font-semibold', SIZES[level - 1], className)}
        data-streamdown={`heading-${level}`}
        {...props}
      >
        {children}
      </Tag>
    );
  }
  Heading.displayName = `MarkdownH${level}`;
  return Heading;
}

export const DEMOTED_HEADINGS = {
  h1: demoted(1),
  h2: demoted(2),
  h3: demoted(3),
  h4: demoted(4),
  h5: demoted(5),
  h6: demoted(6),
};
