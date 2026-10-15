import type { ConversationCompaction } from '@oci/shared';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import { translate, useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

export const compactionDividerText = (): string => translate('chat.compaction.dividerText');

/**
 * A quiet single line above the first message the model still receives
 * verbatim. Everything above stays visible and unchanged; the model sees it
 * only as the summary, which the line discloses on request.
 */
export function CompactionDivider({ compaction }: { compaction: ConversationCompaction }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const count = compaction.messagesSummarized;

  return (
    <section
      aria-label={t('chat.compaction.sectionLabel')}
      data-compaction-divider={compaction.id}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2 text-[0.6875rem] text-[var(--text-muted)]">
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]/60" />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 opacity-80 transition hover:text-[var(--text-primary)] hover:opacity-100"
          title={t('chat.compaction.dividerTitle', { count })}
        >
          {t('chat.compaction.dividerText')}
          <ChevronDown
            aria-hidden="true"
            className={cn('size-3 transition-transform', open && 'rotate-180')}
          />
        </button>
        <span aria-hidden="true" className="h-px flex-1 bg-[var(--border-subtle)]/60" />
      </div>
      {open && (
        <div
          id={panelId}
          className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/40 px-4 py-3 text-sm text-[var(--text-secondary)]"
        >
          <p className="mb-2 text-xs text-[var(--text-muted)]">
            {t('chat.compaction.summaryIntro', { count })}
          </p>
          <Markdown className={MARKDOWN_PROSE}>{compaction.summary}</Markdown>
        </div>
      )}
    </section>
  );
}
