import type { AdminGroupDetail, AdminModel, GroupGrants, QuotaPolicy } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { EditableFieldset, useAdminAccess } from '~/components/admin/admin-access';
import { LoadError } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { ADMIN_GROUPS_KEY, describeGroupError } from '~/lib/groups';
import { cn } from '~/lib/utils';

interface Choice {
  id: string;
  label: string;
  /** Small print after the name: why it does nothing yet, or what else it applies to. */
  note?: string;
  muted?: boolean;
}

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

function Checklist({
  label,
  description,
  choices,
  selected,
  onToggle,
  search,
}: {
  label: string;
  description?: string;
  choices: Choice[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  search?: { value: string; onChange: (value: string) => void; label: string };
}) {
  const headingId = useId();
  return (
    <fieldset aria-labelledby={headingId} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
      <div>
        <h2 id={headingId} className="font-semibold text-base">
          {label}
        </h2>
        {description && (
          <p className="mt-1 max-w-2xl text-[var(--text-muted)] text-sm">{description}</p>
        )}
      </div>
      {search && (
        <div className="relative w-full max-w-sm">
          <Search
            className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={search.label}
            placeholder="Search..."
            className="ps-9"
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
          />
        </div>
      )}
      <ul className="max-h-80 divide-y divide-[var(--border-subtle)] overflow-y-auto rounded-xl border border-[var(--border-subtle)]">
        {choices.length === 0 ? (
          <li className="px-3 py-4 text-[var(--text-muted)] text-xs">Nothing to choose from.</li>
        ) : (
          choices.map((choice) => (
            <li key={choice.id}>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                  'hover:bg-[var(--bg-control-alt)] focus-within:bg-[var(--bg-control-alt)]',
                )}
              >
                <input
                  type="checkbox"
                  checked={selected.has(choice.id)}
                  onChange={() => onToggle(choice.id)}
                  className="size-4 shrink-0 accent-[var(--accent)]"
                />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate',
                    choice.muted && 'text-[var(--text-muted)]',
                  )}
                >
                  {choice.label}
                </span>
                {choice.note && (
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)] uppercase">
                    {choice.note}
                  </span>
                )}
              </label>
            </li>
          ))
        )}
      </ul>
    </fieldset>
  );
}

/** Budgets: the policies of the instance, plus any grant the list no longer returns. */
function policyChoices(policies: QuotaPolicy[] | undefined, grants: GroupGrants): Choice[] {
  const known = new Map<string, Choice>();
  for (const policy of policies ?? []) {
    const roles = policy.roles.length > 0 ? `Also on ${policy.roles.join(', ')}` : undefined;
    known.set(policy.id, {
      id: policy.id,
      label: policy.name,
      note: policy.enabled ? roles : 'Not enforced',
      muted: !policy.enabled,
    });
  }
  for (const policy of grants.policies) {
    if (!known.has(policy.id))
      known.set(policy.id, {
        id: policy.id,
        label: policy.name,
        note: policy.enabled ? undefined : 'Not enforced',
        muted: !policy.enabled,
      });
  }
  return [...known.values()];
}

function modelChoices(models: AdminModel[] | undefined, grants: GroupGrants): Choice[] {
  const known = new Map<string, Choice>();
  for (const model of models ?? [])
    known.set(model.id, {
      id: model.id,
      label: model.displayName,
      note: model.enabled ? undefined : 'Disabled',
      muted: !model.enabled,
    });
  for (const model of grants.models)
    if (!known.has(model.id))
      known.set(model.id, {
        id: model.id,
        label: model.displayName,
        note: model.enabled ? undefined : 'Disabled',
        muted: !model.enabled,
      });
  return [...known.values()];
}

/**
 * What the group grants: two checklists, written only from here, to
 * `PUT /admin/groups/:id/grants` (both lists every time, as the API replaces
 * both). The budget and model forms never carry groups; the API refuses it.
 */
export function GrantsPanel({ group }: { group: AdminGroupDetail }) {
  const queryClient = useQueryClient();
  const { canEdit } = useAdminAccess();
  const [policyIds, setPolicyIds] = useState<ReadonlySet<string>>(
    () => new Set(group.grants.policies.map((policy) => policy.id)),
  );
  const [modelIds, setModelIds] = useState<ReadonlySet<string>>(
    () => new Set(group.grants.models.map((model) => model.id)),
  );
  const [modelSearch, setModelSearch] = useState('');
  const [saved, setSaved] = useState(false);

  const quotas = useQuery({
    queryKey: ['admin', 'quotas'],
    queryFn: () => api.get<{ policies: QuotaPolicy[] }>('/admin/quotas'),
  });
  const catalog = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api.get<{ models: AdminModel[] }>('/admin/models'),
  });

  const savedPolicies = new Set(group.grants.policies.map((policy) => policy.id));
  const savedModels = new Set(group.grants.models.map((model) => model.id));
  const dirty = !sameIds(policyIds, savedPolicies) || !sameIds(modelIds, savedModels);
  useReportUnsaved(dirty);

  const save = useMutation({
    mutationFn: () =>
      api.put<GroupGrants>(`/admin/groups/${group.id}/grants`, {
        policyIds: [...policyIds],
        modelIds: [...modelIds],
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ADMIN_GROUPS_KEY });
    },
  });

  const toggle =
    (set: ReadonlySet<string>, update: (next: ReadonlySet<string>) => void) => (id: string) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      update(next);
      setSaved(false);
      save.reset();
    };

  const term = modelSearch.trim().toLowerCase();
  const models = modelChoices(catalog.data?.models, group.grants).filter(
    (choice) => !term || choice.label.toLowerCase().includes(term),
  );

  if (quotas.isLoading || catalog.isLoading)
    return (
      <div role="status" aria-label="Loading budgets and models" className="py-10">
        <Spinner className="mx-auto size-5" />
      </div>
    );
  if (quotas.isError) return <LoadError title="Budgets could not be loaded." query={quotas} />;
  if (catalog.isError) return <LoadError title="Models could not be loaded." query={catalog} />;

  return (
    <div className="flex flex-col gap-8">
      <EditableFieldset className="flex flex-col gap-8">
        <Checklist
          label="Budgets"
          description="A person is held to the most restrictive of the budgets that apply to them, from their role and from every group. A group budget never raises a limit above one their role already carries, and each person gets the full amount on their own."
          choices={policyChoices(quotas.data?.policies, group.grants)}
          selected={policyIds}
          onToggle={toggle(policyIds, setPolicyIds)}
        />
        <Checklist
          label="Models"
          description="Models the group’s people can use in addition to the ones their role shows. A disabled model stays unavailable."
          choices={models}
          selected={modelIds}
          onToggle={toggle(modelIds, setModelIds)}
          search={{ value: modelSearch, onChange: setModelSearch, label: 'Search models' }}
        />
      </EditableFieldset>

      {canEdit && (
        <div className="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <div className="sm:me-auto" aria-live="polite">
            {save.error && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {describeGroupError(save.error, 'The grants could not be saved.')}
              </p>
            )}
            {saved && <p className="text-[var(--success)] text-sm">Saved.</p>}
          </div>
          <Button
            type="button"
            variant="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Spinner />}
            {save.isPending ? 'Saving…' : 'Save grants'}
          </Button>
        </div>
      )}
    </div>
  );
}
