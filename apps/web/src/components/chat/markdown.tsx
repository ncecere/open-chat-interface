import { type ComponentProps, lazy, memo, Suspense } from 'react';
import { MessageLink } from '~/components/chat/external-link-warning';
import { DEMOTED_HEADINGS } from '~/components/chat/markdown-headings';
import { remarkSoftBreaks } from '~/components/chat/markdown-soft-breaks';
import {
  installStreamdownOverlayFocus,
  installStreamdownScrollRegions,
} from '~/components/chat/streamdown-overlay-focus';
import { readableCodePlugin } from '~/lib/code-contrast';
import { cn } from '~/lib/utils';

/**
 * Streamdown pulls in Shiki's syntax-highlighting grammars, which dominate the
 * bundle. Loading it on demand keeps that cost out of the initial payload; the
 * fallback preserves the text so nothing disappears while it resolves.
 */
const loadRenderer = () =>
  Promise.all([
    import('streamdown'),
    // Shiki's GitHub colours, adjusted where they fall short of AA on our surfaces (#171).
    import('@streamdown/code').then(({ code }) => ({ code: readableCodePlugin(code) })),
    import('@streamdown/math'),
    import('~/components/chat/mermaid-plugin'),
  ]);

const StreamdownMarkdown = lazy(() =>
  loadRenderer().then(
    ([
      { Streamdown, defaultRehypePlugins, defaultRemarkPlugins },
      { code },
      { createMathPlugin },
      { createEditorialMermaidPlugin },
    ]) => {
      // Streamdown's table full-screen view does not manage focus itself.
      installStreamdownOverlayFocus();
      // Its wide tables and code blocks scroll; make them reachable by keyboard.
      installStreamdownScrollRegions();
      const ownerRehypePlugins = conversationRehypePlugins(defaultRehypePlugins);
      // Streamdown's own (GFM, code metadata), then single line breaks kept (#207).
      // One array for every message: Streamdown re-parses when its identity changes.
      const remarkPlugins = [...Object.values(defaultRemarkPlugins ?? {}), remarkSoftBreaks];
      // Single-dollar inline math is off by default, but models commonly emit it.
      // Mermaid itself loads only when a diagram is first rendered.
      const plugins = {
        code,
        math: createMathPlugin({ singleDollarTextMath: true }),
        mermaid: createEditorialMermaidPlugin(),
      };

      return {
        default: ({ children, className, skipHtml, urlTransform }: MarkdownProps) => (
          <Streamdown
            plugins={plugins}
            className={cn(MARKDOWN_BASE, className)}
            remarkPlugins={remarkPlugins}
            // The reference interface shows plain code without a gutter.
            lineNumbers={false}
            // Links are real links that warn before leaving the instance (#174),
            // not Streamdown's link-safety buttons; headings sit below the
            // page's h1 (#212).
            components={MESSAGE_COMPONENTS}
            // Share pages pass their own URL policy and keep the visible marker.
            {...(!skipHtml && !urlTransform && ownerRehypePlugins
              ? { rehypePlugins: ownerRehypePlugins }
              : {})}
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

const MESSAGE_COMPONENTS = { a: MessageLink, ...DEMOTED_HEADINGS };

type Pluggable = NonNullable<
  ComponentProps<typeof import('streamdown').Streamdown>['rehypePlugins']
>[number];

/**
 * Streamdown's own rehype plugins (raw HTML, sanitizing, hardening), with one
 * change for a person's own conversation: a link the hardening refuses (a
 * relative path, or a scheme such as `sandbox:` that models invent) shows as
 * its plain text instead of "text [blocked]". Its destination is still
 * dropped. Null when the defaults are not in the expected shape.
 */
function conversationRehypePlugins(
  defaults: Record<string, Pluggable> | undefined,
): Pluggable[] | null {
  const harden = defaults?.harden;
  if (!defaults || !Array.isArray(harden) || typeof harden[1] !== 'object') return null;
  return Object.entries(defaults).map(([name, plugin]) =>
    name === 'harden'
      ? ([harden[0], { ...(harden[1] as object), linkBlockPolicy: 'text-only' }] as Pluggable)
      : plugin,
  );
}

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

/**
 * One fenced block of source code, highlighted by the same Streamdown code
 * plugin (Shiki, the same themes) as code blocks in replies, from the same
 * lazily loaded chunk. Static mode: the text is never treated as unfinished
 * Markdown. The block's own copy and download controls are hidden; the caller
 * offers its own.
 */
const StreamdownCode = lazy(() =>
  loadRenderer().then(([{ Streamdown }, { code }]) => {
    const plugins = { code };
    return {
      default: ({ source, language, className }: HighlightedCodeProps) => (
        <Streamdown
          plugins={plugins}
          mode="static"
          controls={false}
          lineNumbers={false}
          className={cn(MARKDOWN_BASE, className)}
        >
          {codeFence(source, language)}
        </Streamdown>
      ),
    };
  }),
);

/** A fenced code block that holds `source` exactly, whatever backticks it contains. */
function codeFence(source: string, language: string): string {
  const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}

interface HighlightedCodeProps {
  source: string;
  /** A Shiki language id or alias. */
  language: string;
  className?: string;
}

/** Source code highlighted like a reply's code blocks; plain text until the highlighter loads. */
export const HighlightedCode = memo(function HighlightedCode({
  source,
  language,
  className,
}: HighlightedCodeProps) {
  return (
    <Suspense
      fallback={
        <pre className={cn('m-0 whitespace-pre-wrap break-words font-mono text-xs', className)}>
          <code>{source}</code>
        </pre>
      }
    >
      <StreamdownCode source={source} language={language} className={className} />
    </Suspense>
  );
});

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
 * What every rendering needs, whatever its prose styling (a user's message,
 * a reply, a share page): without the gutter, Shiki's one span per line must
 * be a block again, or every line of a code block collapses onto one row.
 * This lived in the reply's prose classes only, so the share page (which had
 * its own) and user messages showed code on one line (#186).
 *
 * A long unbroken word (a hash, a key, a run of letters) wraps inside the
 * column, as links already did, instead of pushing the conversation or the
 * share page sideways (#187). `anywhere` rather than `break-word`, so the word
 * no longer sets the column's minimum width either. Code blocks keep their
 * lines (`pre` does not wrap) unless the person turned code wrapping on.
 */
const MARKDOWN_BASE = 'wrap-anywhere [&_pre_code]:block [&_pre_code>span]:block';

/**
 * Shared prose styling so chat and public shares render identically (#186:
 * the share page had its own copy, which styled block code as inline code).
 * Only inline code gets the inline-code look.
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
  // Squeezed to the reply's width, a table with many columns left a prose
  // column one word wide (rows 200+ px tall in the QA walk). A table may be as
  // wide as its content, never narrower than the reply, with long cells
  // wrapping at a readable width; a wide one scrolls (a focusable region).
  '[&_[data-streamdown=table]]:w-max [&_[data-streamdown=table]]:min-w-full',
  '[&_[data-streamdown=table-cell]]:max-w-[22rem]',
  '[&_hr]:border-[var(--border-subtle)]',
  '[&_li::marker]:text-[var(--accent-bright)]',
);

// Cache at the wrapper boundary, before normalization and the lazy renderer.
// Safety props and URL transforms participate in the default shallow comparison.
export const Markdown = memo(function Markdown({
  children,
  className,
  skipHtml,
  urlTransform,
}: MarkdownProps) {
  return (
    <Suspense
      fallback={
        <div className={cn('whitespace-pre-wrap wrap-anywhere', className)}>{children}</div>
      }
    >
      <StreamdownMarkdown className={className} skipHtml={skipHtml} urlTransform={urlTransform}>
        {children}
      </StreamdownMarkdown>
    </Suspense>
  );
});
