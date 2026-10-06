import type { ComponentProps, ReactNode } from 'react';
import { cn } from '~/lib/utils';

/**
 * Headings in Markdown one level down (#212). The page's own heading (the
 * conversation's or the share's title) is its one h1; a reply that began
 * "# Ten Facts About Owls" added a second, so screen-reader heading
 * navigation read the reply as a page of its own. Each Markdown level is
 * rendered one element level lower (h1 as h2, ... h5 and h6 as h6) with the
 * size it had before, so replies look the same. `data-streamdown` keeps the
 * Markdown level, as Streamdown's own headings do.
 */
const SIZES = ['text-3xl', 'text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm'] as const;

type HeadingProps = ComponentProps<'h2'> & { node?: unknown; children?: ReactNode };

function demoted(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${Math.min(level + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  function Heading({ node: _node, className, children, ...props }: HeadingProps) {
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
