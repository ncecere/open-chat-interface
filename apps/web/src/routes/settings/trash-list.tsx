import type { TrashedThread } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { api, apiErrorMessage } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';
import { keepFocusWhenRemoved } from '~/lib/focus-return';
import { useReadOnlyLock } from '~/lib/read-only';
import { formatRelativeTime } from '~/lib/utils';

function purgeCountdown(purgeAt: string): string {
  const remaining = new Date(purgeAt).getTime() - Date.now();
  if (remaining <= 0) return 'deleting soon';

  const days = Math.ceil(remaining / 86_400_000);
  if (days > 1) return `deletes in ${days} days`;
  const hours = Math.max(1, Math.ceil(remaining / 3_600_000));
  return `deletes in ${hours} hour${hours === 1 ? '' : 's'}`;
}

function messages(count: number): string {
  return `${count} message${count === 1 ? '' : 's'}`;
}

/**
 * Settings → History → Trash. Restoring is one click; deleting now (one
 * conversation or the whole trash) asks first, as every other permanent
 * deletion does, because it removes the trash's safety net (#132).
 */
export function TrashList() {
  const queryClient = useQueryClient();
  // Restoring and deleting are refused while read-only (#353).
  const lock = useReadOnlyLock();
  const [purging, setPurging] = useState<TrashedThread | null>(null);
  const [emptying, setEmptying] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['threads', 'trash'],
    queryFn: () => api.get<{ threads: TrashedThread[] }>('/threads/trash'),
    select: (result) => result.threads,
  });

  const invalidate = () =>
    Promise.all([
      invalidateConversationLists(queryClient),
      queryClient.invalidateQueries({ queryKey: ['attachments'] }),
    ]);

  const restore = useMutation({
    mutationFn: (thread: TrashedThread) => api.post(`/threads/${thread.id}/restore`),
    // Said, as Delete is: the row only vanished, with no word of where the
    // conversation went (#250). It returns to where it was when deleted.
    onSuccess: (_, thread) => {
      toast.success(`Restored “${thread.title}” from the trash.`);
      return invalidate();
    },
    onError: (error, thread) =>
      toast.error(apiErrorMessage(error, `“${thread.title}” could not be restored. Try again.`)),
  });

  /** The row leaves once the trash refetches; focus goes to the next one, not the body (#250). */
  function restoreRow(event: MouseEvent<HTMLButtonElement>, thread: TrashedThread) {
    const row = event.currentTarget.closest<HTMLElement>('[data-focus-row]');
    if (row) keepFocusWhenRemoved(row);
    restore.mutate(thread);
  }

  const threads = data ?? [];

  if (isLoading) {
    return (
      <div className="py-16">
        <Spinner className="mx-auto size-6" />
      </div>
    );
  }

  if (threads.length === 0) {
    return <p className="mt-10 text-sm text-[var(--text-muted)]">Trash is empty.</p>;
  }

  return (
    <>
      <div className="mt-6 flex items-center justify-between gap-4">
        <p className="text-xs text-[var(--text-muted)]">
          Deleted conversations stay here until their deletion date, then are removed permanently.
          Deleting now cannot be undone, so download anything you want to keep first.
        </p>
        <Button
          variant="danger"
          size="sm"
          aria-haspopup="dialog"
          locked={lock.title}
          onClick={() => setEmptying(true)}
        >
          Empty trash
        </Button>
      </div>

      <div className="mt-4 flex flex-col">
        {threads.map((thread) => {
          // One string, shown and as the tooltip when a phone cuts it short (#130).
          const detail = `${messages(thread.messageCount)} · ${
            thread.deletedReason === 'retention'
              ? 'removed automatically'
              : `deleted ${formatRelativeTime(thread.deletedAt)}`
          } · ${purgeCountdown(thread.purgeAt)}`;
          return (
            <div
              key={thread.id}
              data-focus-row
              className="flex items-center gap-3 border-[var(--border-subtle)] border-b py-3 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p
                  dir="auto"
                  className="truncate text-[var(--text-primary)] text-sm"
                  title={thread.title}
                >
                  {thread.title}
                </p>
                <p className="truncate text-[var(--text-muted)] text-xs" title={detail}>
                  {detail}
                </p>
              </div>

              {/* Named for the row, as the Archived tab's and the sidebar's are (#111, #132). */}
              <Button
                variant="secondary"
                size="sm"
                // Only this row's: a disabled neighbour cannot take focus when this row goes.
                locked={lock.title}
                disabled={restore.isPending && restore.variables?.id === thread.id}
                aria-label={`Restore ${thread.title}`}
                onClick={(event) => restoreRow(event, thread)}
              >
                Restore
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-haspopup="dialog"
                aria-label={`Delete ${thread.title} now`}
                locked={lock.title}
                onClick={() => setPurging(thread)}
              >
                Delete now
              </Button>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={purging !== null}
        onOpenChange={(open) => {
          if (!open) setPurging(null);
        }}
        title="Delete this conversation now?"
        description={
          <>
            {/* Quoted, as the project dialog does: a title's own full stop ran
                into "and its 2 messages" (#254). */}
            “{purging?.title}” and its {messages(purging?.messageCount ?? 0)} are deleted
            permanently, with its files and artifacts. This cannot be undone.
          </>
        }
        confirmLabel="Delete now"
        pendingLabel="Deleting…"
        errorMessage="The conversation could not be deleted."
        confirmDisabled={lock.locked}
        onConfirm={async () => {
          if (!purging) return;
          await api.delete(`/threads/${purging.id}/permanent`);
          await invalidate();
        }}
      />
      <ConfirmDialog
        open={emptying}
        onOpenChange={setEmptying}
        title={
          threads.length === 1
            ? 'Empty the trash?'
            : `Empty the trash of ${threads.length} conversations?`
        }
        description={
          threads.length === 1
            ? 'The conversation in the trash is deleted permanently, with its files and artifacts. This cannot be undone.'
            : `All ${threads.length} conversations in the trash are deleted permanently, with their files and artifacts. This cannot be undone.`
        }
        confirmLabel="Empty trash"
        pendingLabel="Deleting…"
        errorMessage="The trash could not be emptied."
        confirmDisabled={lock.locked}
        onConfirm={async () => {
          await api.delete('/threads/trash');
          await invalidate();
        }}
      />
    </>
  );
}
