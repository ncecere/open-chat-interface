import { type AdminModel, findModelLab } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { LabLogo } from '~/components/model/lab-logo';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

/**
 * Chooses which catalog models a quota policy governs.
 *
 * Selecting nothing means the policy applies to every model, which keeps an
 * instance-wide budget expressible. Lab and provider act only as bulk-select
 * shortcuts rather than live rules: membership stays an explicit list so
 * curating a new model never silently enrolls it in an existing budget.
 */
export function ModelScopePicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (slugs: string[]) => void;
}) {
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api.get<{ models: AdminModel[] }>('/admin/models'),
  });

  const models = useMemo(() => data?.models ?? [], [data]);

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matching = term
      ? models.filter(
          (model) =>
            model.displayName.toLowerCase().includes(term) ||
            model.slug.toLowerCase().includes(term) ||
            (findModelLab(model.labId)?.name.toLowerCase().includes(term) ?? false),
        )
      : models;

    const byLab = new Map<string, { label: string; models: AdminModel[] }>();
    for (const model of matching) {
      const lab = findModelLab(model.labId);
      const key = lab?.id ?? 'other';
      const existing = byLab.get(key) ?? { label: lab?.name ?? 'Other', models: [] };
      existing.models.push(model);
      byLab.set(key, existing);
    }

    return [...byLab.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [models, search]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggle(slug: string) {
    onChange(
      selectedSet.has(slug) ? selected.filter((entry) => entry !== slug) : [...selected, slug],
    );
  }

  function toggleGroup(groupModels: AdminModel[]) {
    const slugs = groupModels.map((model) => model.slug);
    const allSelected = slugs.every((slug) => selectedSet.has(slug));

    onChange(
      allSelected
        ? selected.filter((entry) => !slugs.includes(entry))
        : [...new Set([...selected, ...slugs])],
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          {selected.length === 0
            ? 'Applies to every model. Choose models to limit this policy to them.'
            : `${selected.length} model${selected.length === 1 ? '' : 's'} selected.`}
        </p>
        {selected.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>
            Clear
          </Button>
        )}
      </div>

      <div className="relative">
        <Search
          className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-[var(--text-muted)]"
          aria-hidden="true"
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search models or labs"
          aria-label="Search models"
          className="pl-9"
        />
      </div>

      <div className="max-h-64 overflow-y-auto rounded-xl border border-[var(--border-subtle)]">
        {isLoading && <p className="px-3 py-4 text-xs text-[var(--text-muted)]">Loading models…</p>}

        {!isLoading && groups.length === 0 && (
          <p className="px-3 py-4 text-xs text-[var(--text-muted)]">No models match that search.</p>
        )}

        {groups.map((group) => {
          const allSelected = group.models.every((model) => selectedSet.has(model.slug));

          return (
            <div key={group.label} className="border-[var(--border-subtle)] border-b last:border-0">
              <div className="flex items-center justify-between gap-2 bg-[var(--bg-control-alt)] px-3 py-1.5">
                <span className="font-medium text-[var(--text-muted)] text-xs">{group.label}</span>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.models)}
                  className="text-[var(--accent)] text-xs hover:underline"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              {group.models.map((model) => {
                const checked = selectedSet.has(model.slug);
                return (
                  <label
                    key={model.slug}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
                      'hover:bg-[var(--bg-control-alt)] focus-within:bg-[var(--bg-control-alt)]',
                      checked && 'bg-[var(--accent)]/10',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(model.slug)}
                      className="size-4 shrink-0 accent-[var(--accent)]"
                    />
                    <LabLogo labId={model.labId} />
                    <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
                    {!model.enabled && (
                      <span className="shrink-0 text-[10px] text-[var(--text-muted)] uppercase">
                        Disabled
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
