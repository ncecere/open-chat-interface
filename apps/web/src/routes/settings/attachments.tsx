import type { Attachment } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Files, FileText, ImageIcon, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { StorageMeter } from '~/components/settings/storage-meter';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { api } from '~/lib/api-client';
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
        {FILTERS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            className={cn(
              'text-xs',
              option.value === value && 'bg-[var(--bg-control)] text-[var(--text-primary)]',
            )}
            aria-checked={option.value === value}
            onSelect={() => onChange(option.value)}
          >
            <option.icon />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SettingsAttachmentsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<AttachmentFilter>('all');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const attachments = useQuery({
    queryKey: ['attachments'],
    queryFn: () => api.get<{ attachments: Attachment[] }>('/attachments'),
    select: (result) => result.attachments,
  });

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
    const everyVisibleSelected =
      visible.length > 0 && visible.every((file) => selected.has(file.id));

    setSelected((current) => {
      const next = new Set(current);
      for (const file of visible) {
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
        Manage your uploaded files and attachments. Deleting a file here removes it from the
        relevant threads, but does not delete those threads. This may cause unexpected behavior if
        the file is still in use.
      </p>

      <StorageMeter />

      <div className="mt-5 flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center">
        <FilterMenu value={filter} onChange={changeFilter} />

        {selected.size > 0 && (
          <Button
            variant="accent"
            size="sm"
            className="sm:ml-auto"
            disabled={selected.size > 0 && [...selected].every((id) => deletingIds.has(id))}
            onClick={() => remove.mutate([...selected])}
          >
            <Trash2 />
            Delete ({selected.size})
          </Button>
        )}
      </div>

      {deleteError && (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--danger-foreground)]"
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
        onDelete={(ids) => remove.mutate(ids)}
      />
    </div>
  );
}
