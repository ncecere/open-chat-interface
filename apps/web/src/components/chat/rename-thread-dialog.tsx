import { THREAD_TITLE_MAX_LENGTH } from '@oci/shared';
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
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { useUpdateThread } from '~/hooks/use-threads';
import { apiErrorMessage } from '~/lib/api-client';

/**
 * Renames a conversation. Enter saves and Escape cancels; the name is trimmed
 * and must be 1 to 200 characters, as the API requires. Saving refreshes the
 * sidebar, the open conversation and History together.
 */
export function RenameThreadDialog({
  threadId,
  title,
  open,
  onOpenChange,
}: {
  threadId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-md">
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>The new name shows in the sidebar and in History.</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts from the current name. */}
        {open && (
          <RenameThreadForm threadId={threadId} title={title} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameThreadForm({
  threadId,
  title,
  onDone,
}: {
  threadId: string;
  title: string;
  onDone: () => void;
}) {
  const [name, setName] = useState(title);
  const update = useUpdateThread();
  const inputId = useId();
  const trimmed = name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || update.isPending) return;
    if (trimmed !== title) await update.mutateAsync({ id: threadId, title: trimmed });
    onDone();
  }

  return (
    <form onSubmit={(event) => void submit(event).catch(() => undefined)} noValidate>
      <Field label="Name" htmlFor={inputId}>
        <Input
          id={inputId}
          dir="auto"
          value={name}
          maxLength={THREAD_TITLE_MAX_LENGTH}
          required
          autoComplete="off"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {update.error && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
        >
          {apiErrorMessage(update.error, 'The conversation could not be renamed.')}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!trimmed || update.isPending}>
          {update.isPending && <Spinner />}
          Rename
        </Button>
      </DialogFooter>
    </form>
  );
}
