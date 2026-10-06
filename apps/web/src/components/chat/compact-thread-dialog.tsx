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
import { cn } from '~/lib/utils';

export const COMPACT_ACTION_LABEL = 'Summarise earlier messages now';
export const COMPACTION_PENDING_TEXT = 'Summarising earlier messages…';
/** As the API refuses it (NOTHING_TO_COMPACT), said before anyone fills in the dialog (#153). */
export const NOTHING_TO_SUMMARISE_TEXT =
  'There is nothing to summarise yet. A conversation needs at least two turns before the earlier ones can be summarised.';

/**
 * The conversation's "Summarise earlier messages now" control. While a
 * summary is being made in the background it says so, quietly; the
 * conversation stays usable throughout.
 */
export function CompactConversationControl({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const pending = useCompactionPending(threadId);
  const summarisable = useCompactionSummarisable(threadId) || pending;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={COMPACT_ACTION_LABEL}
        title={
          pending
            ? COMPACTION_PENDING_TEXT
            : summarisable
              ? COMPACT_ACTION_LABEL
              : 'Nothing to summarise yet'
        }
        aria-haspopup="dialog"
        data-compaction-pending={pending || undefined}
        onClick={() => setOpen(true)}
        className="relative"
      >
        <FoldVertical className={cn(pending && 'animate-pulse')} />
        {pending && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-1.5 rounded-full bg-[var(--accent)]"
          />
        )}
      </Button>
      <span role="status" className="sr-only">
        {pending ? COMPACTION_PENDING_TEXT : ''}
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* With nothing to summarise, the footer's Close is the only one: an ×
          beside it was a second control with the same name (#246). */}
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg" closeButton={summarisable}>
        <DialogHeader>
          <DialogTitle>{COMPACT_ACTION_LABEL}</DialogTitle>
          <DialogDescription>
            {summarisable
              ? 'The earlier messages are summarised in the background, and the model receives the summary in their place. You can keep writing meanwhile. Every message stays here as it is. The summary counts towards your usage.'
              : NOTHING_TO_SUMMARISE_TEXT}
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
              Close
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
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          {COMPACTION_PENDING_TEXT} Asking again does not start a second summary.
        </p>
      )}
      <Field
        label="Instructions (optional)"
        htmlFor={id}
        hint="What the summary should keep, for example “keep every figure in the budget”."
      >
        <Textarea
          id={id}
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
          {apiErrorMessage(compact.error, 'The earlier messages could not be summarised.')}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={compact.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={compact.isPending}>
          {compact.isPending && <Spinner />}
          Summarise
        </Button>
      </DialogFooter>
    </form>
  );
}
