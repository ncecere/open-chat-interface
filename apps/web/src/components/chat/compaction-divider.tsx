import type { ConversationCompaction } from '@oci/shared';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import { cn } from '~/lib/utils';

export const COMPACTION_DIVIDER_TEXT = 'Earlier messages were summarised to fit the model';

/**
 * Sits above the first message the model still receives verbatim. Everything
 * above stays visible; the model sees it only as the summary, which the
 * divider expands to show.
 */
export function CompactionDivider({ compaction }: { compaction: ConversationCompaction }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const count = compaction.messagesSummarized;

  return (
    <section
      aria-label="Conversation summary"
      data-compaction-divider={compaction.id}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
          className="flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:text-[var(--text-primary)]"
          title={`${count} earlier ${count === 1 ? 'message' : 'messages'} summarised`}
        >
          {COMPACTION_DIVIDER_TEXT}
          <ChevronDown
            aria-hidden="true"
            className={cn('size-3.5 transition-transform', open && 'rotate-180')}
          />
        </button>
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]" />
      </div>
      {open && (
        <div
          id={panelId}
          className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 px-4 py-3 text-sm text-[var(--text-secondary)]"
        >
          <p className="mb-2 text-xs text-[var(--text-muted)]">
            What the model receives in place of the {count} earlier{' '}
            {count === 1 ? 'message' : 'messages'} above.
          </p>
          <Markdown className={MARKDOWN_PROSE}>{compaction.summary}</Markdown>
        </div>
      )}
    </section>
  );
}
