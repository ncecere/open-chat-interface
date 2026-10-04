import { Info } from 'lucide-react';
import { Markdown } from '~/components/chat/markdown';
import { cn } from '~/lib/utils';

/** How much of the end of the reasoning the live preview keeps: a little more than it shows. */
const PREVIEW_CHARS = 600;

/**
 * The latest reasoning as plain text for the live preview: a bounded slice of
 * the end, with the commonest Markdown markers dropped. Cheap enough to run on
 * every streamed token, unlike rendering Markdown.
 */
export function reasoningTail(text: string): string {
  const recent = text.length > PREVIEW_CHARS ? text.slice(-PREVIEW_CHARS) : text;
  return recent
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * While the model is still thinking, a small window under the collapsed
 * header with the latest few lines, pinned to the end as they arrive. It is
 * decorative (hidden from screen readers, who get the disclosure and,
 * expanded, the full text); clicking it is a pointer shortcut to expanding.
 */
export function ReasoningPreview({ text, onExpand }: { text: string; onExpand: () => void }) {
  return (
    // A pointer shortcut only: the header button is the keyboard route.
    <div
      aria-hidden="true"
      data-reasoning-preview=""
      onClick={onExpand}
      className={cn(
        // About three lines, the newest at the bottom; older ones fade out at the top.
        'mt-2 flex h-[3.75rem] cursor-pointer flex-col justify-end overflow-hidden',
        'text-[0.75rem] leading-5 text-[var(--text-muted)]',
        '[mask-image:linear-gradient(to_bottom,transparent,black_1.75rem)]',
      )}
    >
      <p className="m-0 whitespace-pre-line break-words">{reasoningTail(text)}</p>
    </div>
  );
}

/** Reasoning as the expanded disclosure shows it: Markdown on a quiet panel. */
export function ReasoningText({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-lg bg-black/15 px-3 py-3 text-[0.9375rem] leading-7 text-[var(--text-secondary)]',
        className,
      )}
    >
      <Markdown
        className={cn(
          'prose-headings:font-semibold prose-headings:text-[var(--text-primary)]',
          '[&_strong]:text-[var(--text-primary)]',
          '[&_code]:rounded [&_code]:bg-black/20 [&_code]:px-1 [&_code]:py-0.5',
          '[&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border-subtle)]',
          '[&_li::marker]:text-[var(--accent-bright)]',
        )}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function ReasoningNote() {
  return (
    <p className="mt-2 flex items-start gap-2 px-1 text-[0.6875rem] leading-4 text-[var(--text-muted)]">
      <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span>
        Some models hide parts of their thinking, so you may see a summary or partial reasoning
        here.
      </span>
    </p>
  );
}
