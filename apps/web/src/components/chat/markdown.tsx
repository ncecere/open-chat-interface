import { type ComponentProps, lazy, Suspense } from 'react';
import { MARKDOWN_LINK_SAFETY } from '~/components/chat/external-link-warning';
import { cn } from '~/lib/utils';

/**
 * Streamdown pulls in Shiki's syntax-highlighting grammars, which dominate the
 * bundle. Loading it on demand keeps that cost out of the initial payload; the
 * fallback preserves the text so nothing disappears while it resolves.
 */
const StreamdownMarkdown = lazy(() =>
  Promise.all([import('streamdown'), import('@streamdown/code'), import('@streamdown/math')]).then(
    ([{ Streamdown }, { code }, { createMathPlugin }]) => {
      // Single-dollar inline math is off by default, but models commonly emit it.
      const plugins = { code, math: createMathPlugin({ singleDollarTextMath: true }) };

      return {
        default: ({ children, className, skipHtml, urlTransform }: MarkdownProps) => (
          <Streamdown
            plugins={plugins}
            className={className}
            // The reference interface shows plain code without a gutter.
            lineNumbers={false}
            linkSafety={MARKDOWN_LINK_SAFETY}
            {...(skipHtml ? { skipHtml } : {})}
            {...(urlTransform
              ? { urlTransform: urlTransform as ComponentProps<typeof Streamdown>['urlTransform'] }
              : {})}
          >
            {normalizeMathDelimiters(children)}
          </Streamdown>
        ),
      };
    },
  ),
);

/**
 * Rewrites LaTeX bracket delimiters into the dollar forms the math plugin
 * understands. Models frequently emit `\\(x\\)` and `\\[x\\]`, which would
 * otherwise render as literal backslashes in the middle of a sentence.
 *
 * Fenced and inline code are left untouched so a snippet demonstrating LaTeX
 * is not silently rewritten.
 */
export function normalizeMathDelimiters(markdown: string): string {
  const segments = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/g);

  return segments
    .map((segment, index) => {
      // Odd indices are the captured code spans.
      if (index % 2 === 1) return segment;
      return segment
        .replace(/\\\[([\s\S]+?)\\\]/g, (_match, body) => `$$${body}$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_match, body) => `$${body}$`);
    })
    .join('');
}

export interface MarkdownProps {
  children: string;
  className?: string;
  skipHtml?: boolean;
  /**
   * Matches Streamdown's signature. Public shares use this to drop every
   * destination that is not a safe external href, so the shape must be
   * preserved rather than narrowed.
   */
  urlTransform?: (value: string, key: string, node: unknown) => string | null;
}

/**
 * Shared prose styling so chat and public shares render identically.
 *
 * Streamdown wraps every fence in its own bordered container and inner scroll
 * pane. Adding a third border around `pre` produced a visibly nested box, so
 * the inner surfaces are flattened and only the outer container keeps a
 * border, matching the single flat panel in the reference interface.
 */
export const MARKDOWN_PROSE = cn(
  'prose-headings:font-semibold prose-headings:text-[var(--text-primary)]',
  '[&_a]:text-[var(--accent-bright)] [&_a]:underline-offset-2',
  '[&_strong]:text-[var(--text-primary)]',
  // Inline code only; fenced blocks are styled by their container.
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-[var(--bg-control)]',
  '[&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5',
  '[&_pre]:!border-0 [&_pre]:!bg-transparent [&_pre]:!rounded-none [&_pre]:!p-0',
  // The scroll pane sits inside the container's own border; a second one reads
  // as a nested box rather than the single flat panel the reference shows.
  '[&>div>div.overflow-x-auto]:!border-0 [&>div>div.overflow-x-auto]:!rounded-none',
  // Shiki emits one span per line. Without the gutter they need to be blocks
  // again, or every line collapses onto one row.
  '[&_pre_code]:block [&_pre_code>span]:block',
  '[&_hr]:border-[var(--border-subtle)]',
  '[&_li::marker]:text-[var(--accent-bright)]',
);

export function Markdown({ children, className, skipHtml, urlTransform }: MarkdownProps) {
  return (
    <Suspense fallback={<div className={cn('whitespace-pre-wrap', className)}>{children}</div>}>
      <StreamdownMarkdown className={className} skipHtml={skipHtml} urlTransform={urlTransform}>
        {children}
      </StreamdownMarkdown>
    </Suspense>
  );
}
