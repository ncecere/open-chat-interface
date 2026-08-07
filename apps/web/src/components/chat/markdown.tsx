import { type ComponentProps, lazy, Suspense } from 'react';
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
            {...(skipHtml ? { skipHtml } : {})}
            {...(urlTransform
              ? { urlTransform: urlTransform as ComponentProps<typeof Streamdown>['urlTransform'] }
              : {})}
          >
            {children}
          </Streamdown>
        ),
      };
    },
  ),
);

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

/** Shared prose styling so chat and public shares render identically. */
export const MARKDOWN_PROSE = cn(
  'prose-headings:font-semibold prose-headings:text-[var(--text-primary)]',
  '[&_a]:text-[var(--accent-bright)] [&_a]:underline-offset-2',
  '[&_strong]:text-[var(--text-primary)]',
  '[&_code]:rounded [&_code]:bg-[var(--bg-control)] [&_code]:px-1 [&_code]:py-0.5',
  '[&_pre]:rounded-xl [&_pre]:border [&_pre]:border-[var(--border-subtle)]',
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
