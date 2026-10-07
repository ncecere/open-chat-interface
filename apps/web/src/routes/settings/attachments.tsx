import type { StoredFile } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Files, FileText, ImageIcon, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { StorageMeter } from '~/components/settings/storage-meter';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { type CurrentFeatures, useCurrentUser } from '~/hooks/use-current-user';
import { api } from '~/lib/api-client';
import { useReadOnlyLock } from '~/lib/read-only';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import { cn } from '~/lib/utils';
import { AttachmentList } from '~/routes/settings/attachment-list';

const FILTERS = [
  { value: 'all', label: 'All Files', icon: Files },
  { value: 'image', label: 'Images', icon: ImageIcon },
  { value: 'pdf', label: 'PDF Documents', icon: FileText },
  { value: 'text', label: 'Text Documents', icon: FileText },
] as const;

type AttachmentFilter = (typeof FILTERS)[number]['value'];
type SortDirection = 'asc' | 'desc';

function isTextDocument(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    [
      'application/json',
      'application/ld+json',
      'application/xml',
      'application/javascript',
      'application/x-yaml',
    ].includes(mimeType)
  );
}

function matchesFilter(mimeType: string, filter: AttachmentFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'image') return mimeType.startsWith('image/');
  if (filter === 'pdf') return mimeType === 'application/pdf';
  return isTextDocument(mimeType);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The attachment could not be deleted.';
}

interface FilterMenuProps {
  value: AttachmentFilter;
  onChange: (value: AttachmentFilter) => void;
}

function FilterMenu({ value, onChange }: FilterMenuProps) {
  const active = FILTERS.find((option) => option.value === value) ?? FILTERS[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-9 w-full items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-xs font-medium text-[var(--text-primary)] transition-colors sm:w-40',
            'hover:bg-[var(--bg-control-hover)] data-[state=open]:border-[var(--accent-bright)]',
          )}
          aria-label={`Filter attachments: ${active.label}`}
        >
          <span>{active.label}</span>
          <ChevronDown className="size-3.5 text-[var(--text-secondary)]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-40"
      >
        {/* One choice of four: radio items, announced as checked (#114). */}
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as AttachmentFilter)}
        >
          {FILTERS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className={cn(
                'text-xs',
                option.value === value && 'bg-[var(--bg-control)] text-[var(--text-primary)]',
              )}
            >
              <option.icon />
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where this person's uploads would come from (#181): no invitation to upload
 * for a role that can do neither, which says so as other refused features do.
 */
function emptyHint(features: CurrentFeatures | undefined): string | undefined {
  if (!features) return undefined;
  if (features.attachments && features.projects) return undefined;
  if (features.attachments) return 'Files you attach in chats will appear here.';
  if (features.projects) return 'Files you add to projects will appear here.';
  return 'Uploading files is not available for your role.';
}

/**
 * What deleting does, for the files chosen. A file marked "Not sent" (#297)
 * was never in a conversation, and the dialog said it would be removed from
 * the conversations it was attached to (#316). It is not removed from them:
 * the conversation keeps the file's name, shown as removed, and the model is
 * told it is gone (#378).
 */
function deleteDescription(count: number, unsent: number): string {
  if (count <= 1)
    return unsent
      ? 'It was never sent. This cannot be undone.'
      : 'The file is deleted and models can no longer read it. It stays visible in the conversation it was attached to, marked as removed. This cannot be undone.';
  if (unsent === count) return 'They were never sent. This cannot be undone.';
  return unsent
    ? 'Those that were sent are deleted and models can no longer read them. Each stays visible in the conversation it was attached to, marked as removed. This cannot be undone.'
    : 'The files are deleted and models can no longer read them. Each stays visible in the conversation it was attached to, marked as removed. This cannot be undone.';
}

export function SettingsAttachmentsPage() {
  const queryClient = useQueryClient();
  const features = useCurrentUser().data?.features;
  // Deleting files is refused while read-only (#353).
  const lock = useReadOnlyLock();
  const [filter, setFilter] = useState<AttachmentFilter>('all');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(deleteError, () => setDeleteError(null));

  const attachments = useQuery({
    queryKey: ['attachments'],
    queryFn: () => api.get<{ attachments: StoredFile[] }>('/attachments'),
    select: (result) => result.attachments,
  });

  const [confirming, setConfirming] = useState<string[] | null>(null);
  const confirmName =
    confirming?.length === 1
      ? attachments.data?.find((file) => file.id === confirming[0])?.filename
      : undefined;
  const confirmTitle = confirmName
    ? `Delete ${confirmName}?`
    : `Delete ${confirming?.length ?? 0} files?`;
  const confirmUnsent = (confirming ?? []).filter(
    (id) => attachments.data?.find((file) => file.id === id)?.unsent,
  ).length;

  const remove = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => api.delete(`/attachments/${id}`)));
      const deleted: string[] = [];
      const failed: unknown[] = [];

      results.forEach((result, index) => {
        const id = ids[index];
        if (result.status === 'fulfilled' && id) deleted.push(id);
        else if (result.status === 'rejected') failed.push(result.reason);
      });

      return { deleted, failed };
    },
    onMutate: (ids) => {
      setDeleteError(null);
      setDeletingIds((current) => new Set([...current, ...ids]));
    },
    onSuccess: ({ deleted, failed }) => {
      setSelected((current) => {
        const next = new Set(current);
        for (const id of deleted) next.delete(id);
        return next;
      });

      if (failed.length > 0) {
        setDeleteError(
          failed.length === 1
            ? errorMessage(failed[0])
            : `${failed.length} attachments could not be deleted. Please try again.`,
        );
      }
    },
    onError: (error) => setDeleteError(errorMessage(error)),
    onSettled: (_data, _error, ids) => {
      setDeletingIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['attachments'] });
      // A conversation already loaded shows its file as removed now (#378).
      void queryClient.invalidateQueries({ queryKey: ['thread'] });
    },
  });

  const visible = useMemo(() => {
    return (attachments.data ?? [])
      .filter((file) => matchesFilter(file.mimeType, filter))
      .sort((left, right) => {
        const difference = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
        return sortDirection === 'asc' ? difference : -difference;
      });
  }, [attachments.data, filter, sortDirection]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    // Project files are managed from their project, so they are never selected here.
    const selectable = visible.filter((file) => !file.project);
    const everyVisibleSelected =
      selectable.length > 0 && selectable.every((file) => selected.has(file.id));

    setSelected((current) => {
      const next = new Set(current);
      for (const file of selectable) {
        if (everyVisibleSelected) next.delete(file.id);
        else next.add(file.id);
      }
      return next;
    });
  }

  function changeFilter(nextFilter: AttachmentFilter) {
    setFilter(nextFilter);
    setSelected(new Set());
    setDeleteError(null);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Attachments</h1>
      <p className="mt-1 max-w-4xl text-sm leading-5 text-[var(--text-secondary)]">
        Files you uploaded in chats and to projects. Deleting a chat file deletes it: the
        conversation it is listed with keeps its name, shown as removed, and models can no longer
        read it. A fork or an edit has its own copy of each file, listed and counted separately.
        Project files are managed from their project.
      </p>

      <StorageMeter />

      <div className="mt-5 flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center">
        <FilterMenu value={filter} onChange={changeFilter} />

        {selected.size > 0 && (
          <Button
            variant="accent"
            size="sm"
            className="sm:ml-auto"
            locked={lock.title}
            disabled={selected.size > 0 && [...selected].every((id) => deletingIds.has(id))}
            onClick={() => setConfirming([...selected])}
          >
            <Trash2 />
            Delete ({selected.size})
          </Button>
        )}
      </div>

      {deleteError && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
        >
          {deleteError}
        </div>
      )}

      <AttachmentList
        attachments={visible}
        totalCount={attachments.data?.length ?? 0}
        selected={selected}
        deletingIds={deletingIds}
        isLoading={attachments.isLoading}
        isError={attachments.isError}
        sortDirection={sortDirection}
        onRetry={() => void attachments.refetch()}
        onSort={() => setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))}
        onToggle={toggle}
        onToggleAll={toggleAllVisible}
        onDelete={(ids) => setConfirming(ids)}
        emptyHint={emptyHint(features)}
      />

      {/* Deleting is permanent, so it asks first (#101). Failures are reported
          on the page, as before. */}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirmTitle}
        // Said in the plural for several files (#179).
        description={deleteDescription(confirming?.length ?? 0, confirmUnsent)}
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        errorMessage="The files could not be deleted."
        confirmDisabled={lock.locked}
        onConfirm={() => remove.mutateAsync(confirming ?? [])}
      />
    </div>
  );
}
