import { Brain, ChevronDown, Info } from 'lucide-react';
import { memo, useState } from 'react';
import { Markdown } from '~/components/chat/markdown';
import { cn } from '~/lib/utils';

export const ReasoningPanel = memo(function ReasoningPanel({
  text,
  streaming,
  answerStarted,
}: {
  text: string;
  streaming: boolean;
  answerStarted: boolean;
}) {
  const [choice, setChoice] = useState<boolean | null>(null);

  // Expand while reasoning is all we have; collapse once the answer starts.
  // An explicit user choice always wins.
  const open = choice ?? (streaming && !answerStarted);

  return (
    <div className="mb-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        className="flex w-fit items-center gap-2 text-left text-[0.8125rem] font-medium text-[var(--text-primary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        <Brain className={cn('size-4 shrink-0', streaming && 'animate-pulse')} />
        <span>{streaming ? 'Thinking...' : 'Reasoning'}</span>
        <ChevronDown
          className={cn(
            'size-3.5 text-[var(--text-muted)] transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <>
          <div className="mt-4 rounded-lg bg-black/15 px-3 py-3 text-[0.9375rem] leading-7 text-[var(--text-secondary)]">
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
          <p className="mt-2 flex items-start gap-2 px-1 text-[0.6875rem] leading-4 text-[var(--text-muted)]">
            <Info className="mt-0.5 size-3 shrink-0" />
            <span>
              Some models hide parts of their thinking, so you may see a summary or partial
              reasoning here.
            </span>
          </p>
        </>
      )}
    </div>
  );
});
