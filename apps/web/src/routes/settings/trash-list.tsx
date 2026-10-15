import type { TrashedThread } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type MouseEvent, useState } from 'react';
import { toast } from 'sonner';
import { SettingsConfirmDialog } from '~/components/settings/confirm-dialog';
import { tWithUserText } from '~/components/settings/user-text';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { api, apiErrorMessage } from '~/lib/api-client';
import { invalidateConversationLists } from '~/lib/conversation-cache';
import { keepFocusWhenRemoved } from '~/lib/focus-return';
import { formatRelativeTime, type Translate, translate, useT } from '~/lib/i18n';
import { useReadOnlyLock } from '~/lib/read-only';

function purgeCountdown(t: Translate, purgeAt: string): string {
  const remaining = new Date(purgeAt).getTime() - Date.now();
  if (remaining <= 0) return t('settings.trash.purgeSoon');

  const days = Math.ceil(remaining / 86_400_000);
  if (days > 1) return t('settings.trash.purgeDays', { count: days });
  const hours = Math.max(1, Math.ceil(remaining / 3_600_000));
  return t('settings.trash.purgeHours', { count: hours });
}

/**
 * Settings → History → Trash. Restoring is one click; deleting now (one
 * conversation or the whole trash) asks first, as every other permanent
 * deletion does, because it removes the trash's safety net (#132).
 */
export function TrashList() {
  const t = useT();
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
      toast.success(translate('settings.trash.restored', { title: thread.title }));
      return invalidate();
    },
    onError: (error, thread) =>
      toast.error(
        apiErrorMessage(error, translate('settings.trash.restoreFailed', { title: thread.title })),
      ),
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
    return <p className="mt-10 text-sm text-[var(--text-muted)]">{t('settings.trash.empty')}</p>;
  }

  return (
    <>
      <div className="mt-6 flex items-center justify-between gap-4">
        <p className="text-xs text-[var(--text-muted)]">{t('settings.trash.intro')}</p>
        <Button
          variant="danger"
          size="sm"
          aria-haspopup="dialog"
          locked={lock.title}
          onClick={() => setEmptying(true)}
        >
          {t('settings.trash.emptyButton')}
        </Button>
      </div>

      <div className="mt-4 flex flex-col">
        {threads.map((thread) => {
          // One string, shown and as the tooltip when a phone cuts it short (#130).
          const detail =
            thread.deletedReason === 'retention'
              ? t('settings.trash.detailAuto', {
                  count: thread.messageCount,
                  purge: purgeCountdown(t, thread.purgeAt),
                })
              : t('settings.trash.detailUser', {
                  count: thread.messageCount,
                  when: formatRelativeTime(thread.deletedAt),
                  purge: purgeCountdown(t, thread.purgeAt),
                });
          return (
            <div
              key={thread.id}
              data-focus-row
              className="flex items-center gap-3 border-[var(--border-subtle)] border-b py-3 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p
                  dir="auto"
                  className="line-clamp-2 text-ellipsis [overflow-wrap:anywhere] text-[var(--text-primary)] text-sm"
                  title={thread.title}
                >
                  {thread.title}
                </p>
                <p
                  className="line-clamp-2 text-ellipsis [overflow-wrap:anywhere] text-[var(--text-muted)] text-xs"
                  title={detail}
                >
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
                aria-label={t('settings.trash.restoreLabel', { title: thread.title })}
                onClick={(event) => restoreRow(event, thread)}
              >
                {t('settings.trash.restore')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-haspopup="dialog"
                aria-label={t('settings.trash.deleteNowLabel', { title: thread.title })}
                locked={lock.title}
                onClick={() => setPurging(thread)}
              >
                {t('settings.trash.deleteNow')}
              </Button>
            </div>
          );
        })}
      </div>

      <SettingsConfirmDialog
        open={purging !== null}
        onOpenChange={(open) => {
          if (!open) setPurging(null);
        }}
        title={t('settings.trash.purgeTitle')}
        description={
          // Quoted, as the project dialog does: a title's own full stop ran
          // into "and its 2 messages" (#254).
          tWithUserText(
            t,
            'settings.trash.purgeDescription',
            { title: purging?.title ?? '', count: purging?.messageCount ?? 0 },
            ['title'],
          )
        }
        confirmLabel={t('settings.trash.deleteNow')}
        pendingLabel={t('settings.trash.deleting')}
        errorMessage={t('settings.trash.purgeFailed')}
        confirmDisabled={lock.locked}
        onConfirm={async () => {
          if (!purging) return;
          await api.delete(`/threads/${purging.id}/permanent`);
          await invalidate();
        }}
      />
      <SettingsConfirmDialog
        open={emptying}
        onOpenChange={setEmptying}
        title={t('settings.trash.emptyTitle', { count: threads.length })}
        description={t('settings.trash.emptyDescription', { count: threads.length })}
        confirmLabel={t('settings.trash.emptyButton')}
        pendingLabel={t('settings.trash.deleting')}
        errorMessage={t('settings.trash.emptyFailed')}
        confirmDisabled={lock.locked}
        onConfirm={async () => {
          await api.delete('/threads/trash');
          await invalidate();
        }}
      />
    </>
  );
}
