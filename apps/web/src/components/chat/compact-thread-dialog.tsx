import { COMPACTION_INSTRUCTIONS_MAX_LENGTH } from '@oci/shared';
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
import { useCompactThread } from '~/hooks/use-compaction';
import { apiErrorMessage } from '~/lib/api-client';

/**
 * "Compact conversation": summarise the earlier messages now, optionally
 * telling the summary what to keep. Messages stay visible; only what the
 * model receives changes.
 */
export function CompactThreadDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle>Compact conversation</DialogTitle>
          <DialogDescription>
            Earlier messages are summarised and the model receives the summary in their place, so
            the conversation keeps fitting the model. Every message stays here as it is. The summary
            counts towards your usage.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each attempt starts empty. */}
        <CompactThreadForm threadId={threadId} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CompactThreadForm({ threadId, onDone }: { threadId: string; onDone: () => void }) {
  const [instructions, setInstructions] = useState('');
  const compact = useCompactThread(threadId);
  const id = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    await compact.mutateAsync(instructions);
    onDone();
  }

  return (
    <form onSubmit={(event) => void submit(event).catch(() => undefined)}>
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
          className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-foreground)]"
        >
          {apiErrorMessage(compact.error, 'The conversation could not be compacted.')}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={compact.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={compact.isPending}>
          {compact.isPending && <Spinner />}
          {compact.isPending ? 'Summarising…' : 'Compact'}
        </Button>
      </DialogFooter>
    </form>
  );
}
