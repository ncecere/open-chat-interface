import { COMPACTION_INSTRUCTIONS_MAX_LENGTH } from '@oci/shared';
import { FoldVertical } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import {
  useCompactionPending,
  useCompactionSummarisable,
  useCompactThread,
} from '~/hooks/use-compaction';
import { apiErrorMessage } from '~/lib/api-client';
import { translate, useT } from '~/lib/i18n';
import { useReadOnlyLock } from '~/lib/read-only';
import { cn } from '~/lib/utils';

export const compactActionLabel = (): string => translate('chat.compaction.actionLabel');
export const compactionPendingText = (): string => translate('chat.compaction.pending');

/**
 * The conversation's "Summarise earlier messages now" control. While a
 * summary is being made in the background it says so, quietly; the
 * conversation stays usable throughout.
 */
export function CompactConversationControl({ threadId }: { threadId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pending = useCompactionPending(threadId);
  const summarisable = useCompactionSummarisable(threadId) || pending;
  // Summarising saves a summary: off while read-only, with the reason (#331).
  const lock = useReadOnlyLock();
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('chat.compaction.actionLabel')}
        title={
          pending
            ? t('chat.compaction.pending')
            : summarisable
              ? t('chat.compaction.actionLabel')
              : t('chat.compaction.nothingYet')
        }
        locked={lock.title}
        aria-haspopup="dialog"
        data-compaction-pending={pending || undefined}
        onClick={() => setOpen(true)}
        className="relative"
      >
        <FoldVertical className={cn(pending && 'animate-pulse motion-reduce:animate-none')} />
        {pending && (
          <span
            aria-hidden="true"
            className="absolute end-1 top-1 size-1.5 rounded-full bg-[var(--accent)]"
          />
        )}
      </Button>
      <span role="status" className="sr-only">
        {pending ? t('chat.compaction.pending') : ''}
      </span>
      <CompactThreadDialog
        threadId={threadId}
        pending={pending}
        summarisable={summarisable}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * "Summarise earlier messages now", optionally telling the summary what to
 * keep. The summary is made in the background: the dialog closes at once and
 * the person keeps writing. Messages stay visible; only what the model
 * receives changes.
 */
export function CompactThreadDialog({
  threadId,
  pending = false,
  summarisable = true,
  open,
  onOpenChange,
}: {
  threadId: string;
  pending?: boolean;
  /** False when there is nothing to summarise yet: the dialog says so instead of asking. */
  summarisable?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* With nothing to summarise, the footer's Close is the only one: an ×
          beside it was a second control with the same name (#246). */}
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg" closeButton={summarisable}>
        <DialogHeader>
          <DialogTitle>{t('chat.compaction.actionLabel')}</DialogTitle>
          <DialogDescription>
            {summarisable
              ? t('chat.compaction.dialogDescription')
              : t('chat.compaction.nothingToSummarise')}
          </DialogDescription>
        </DialogHeader>
        {summarisable ? (
          // Mounted only while open, so each attempt starts empty.
          <CompactThreadForm
            threadId={threadId}
            pending={pending}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t('chat.compaction.close')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CompactThreadForm({
  threadId,
  pending,
  onDone,
}: {
  threadId: string;
  pending: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const [instructions, setInstructions] = useState('');
  const compact = useCompactThread(threadId);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    await compact.mutateAsync(instructions);
    onDone();
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event).catch(() => undefined)}>
      {pending && (
        <p className="mb-3 text-xs text-[var(--text-muted)]">{t('chat.compaction.pendingAgain')}</p>
      )}
      <Field
        label={t('chat.compaction.instructionsLabel')}
        htmlFor={id}
        hint={t('chat.compaction.instructionsHint')}
      >
        <Textarea
          id={id}
          dir="auto"
          rows={3}
          maxLength={COMPACTION_INSTRUCTIONS_MAX_LENGTH}
          value={instructions}
          disabled={compact.isPending}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </Field>
      {compact.error && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
        >
          {apiErrorMessage(compact.error, t('chat.compaction.failed'))}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={compact.isPending}>
          {t('chat.compaction.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={compact.isPending}>
          {compact.isPending && <Spinner />}
          {t('chat.compaction.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
