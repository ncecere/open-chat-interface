import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { api } from '~/lib/api-client';
import { savedUserFilters, type UserDirectoryFilters } from './directory-filters';

interface SavedView {
  id: string;
  name: string;
  filters: Record<string, string>;
}

/** Kept at page scope so loading the directory does not reset the view draft. */
export function useSavedUserViews(
  filters: UserDirectoryFilters,
  applyFilters: (filters: Record<string, string>) => void,
) {
  const [viewName, setViewName] = useState('');
  const queryClient = useQueryClient();
  const views = useQuery({
    queryKey: ['admin', 'views', 'users'],
    queryFn: () => api.get<{ views: SavedView[] }>('/admin/views?surface=users'),
  });
  const saveView = useMutation({
    mutationFn: () =>
      api.post('/admin/views', {
        surface: 'users',
        name: viewName.trim(),
        filters: savedUserFilters(filters),
      }),
    onSuccess: () => {
      setViewName('');
      queryClient.invalidateQueries({ queryKey: ['admin', 'views', 'users'] });
    },
  });
  const deleteView = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/views/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'views', 'users'] }),
  });

  return {
    views: views.data?.views,
    viewName,
    setViewName,
    saveView,
    deleteView,
    applyView: (view: SavedView) => applyFilters(view.filters),
    // Offering to save "everything, unsorted" would just add clutter.
    hasActiveFilters:
      filters.search.trim() !== '' || filters.role !== 'all' || filters.status !== 'all',
  };
}

export function SavedUserViews({ views: state }: { views: ReturnType<typeof useSavedUserViews> }) {
  const { views, viewName, setViewName, saveView, deleteView, applyView, hasActiveFilters } = state;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {views?.map((view) => (
        <span
          key={view.id}
          className="flex items-center gap-1 rounded-full bg-[var(--bg-control-alt)] pr-1 pl-3 text-sm"
        >
          <button
            type="button"
            className="py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={() => applyView(view)}
          >
            {view.name}
          </button>
          <button
            type="button"
            aria-label={`Delete the ${view.name} view`}
            className="rounded p-1 text-[var(--text-faint)] hover:text-[var(--text-primary)]"
            onClick={() => deleteView.mutate(view.id)}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      {hasActiveFilters && (
        <span className="flex items-center gap-2">
          <Input
            aria-label="Name for this view"
            className="h-8 w-44"
            placeholder="Save these filters as…"
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={!viewName.trim() || saveView.isPending}
            onClick={() => saveView.mutate()}
          >
            Save view
          </Button>
        </span>
      )}
    </div>
  );
}
