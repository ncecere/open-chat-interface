import { type AdminDataClass, dataClassInUseDetailsSchema } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { EmptyState } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { ADMIN_DATA_CLASSES_KEY } from '~/components/admin/data-class-select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { ADMIN_CLASSIFICATION_KEY } from '~/hooks/use-admin-classification';
import { ApiError, api } from '~/lib/api-client';
import { countOf, listNames } from '~/lib/classification';
import { ClassFormDialog } from './class-form-dialog';

/** What still refers to a class that cannot be deleted, as one sentence. */
export function inUseText(
  name: string,
  usage: { connectors: number; projects: number; threads: number },
): string {
  const parts = [
    countOf(usage.connectors, 'connector'),
    countOf(usage.projects, 'project'),
    countOf(usage.threads, 'conversation'),
  ].flatMap((part) => part ?? []);
  return `${name} is still used by ${listNames(parts)}, so it cannot be deleted. Remove it from those first, or retire it to stop new labels.`;
}

function usageOf(entry: AdminDataClass) {
  return {
    connectors: entry.connectorCount,
    projects: entry.projectCount,
    threads: entry.threadCount,
  };
}

const inUse = (entry: AdminDataClass) =>
  entry.connectorCount + entry.projectCount + entry.threadCount > 0;

function ClassRow({
  entry,
  onRename,
  onRetire,
  onDelete,
}: {
  entry: AdminDataClass;
  onRename: () => void;
  onRetire: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      data-testid="data-class"
      className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{entry.name}</h3>
          {entry.retiredAt && <Badge variant="neutral">Retired</Badge>}
        </div>
        {entry.description && (
          <p className="mt-0.5 max-w-2xl text-sm text-[var(--text-muted)]">{entry.description}</p>
        )}
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Approved for {countOf(entry.modelCount, 'model') ?? 'no models'} · carried by{' '}
          {countOf(entry.connectorCount, 'connector') ?? 'no connectors'} · on{' '}
          {countOf(entry.projectCount, 'project') ?? 'no projects'} and{' '}
          {countOf(entry.threadCount, 'conversation') ?? 'no conversations'}
        </p>
      </div>
      <EditOnly>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Rename ${entry.name}`}
            onClick={onRename}
          >
            <Pencil />
          </Button>
          {!entry.retiredAt && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Retire ${entry.name}`}
              onClick={onRetire}
            >
              <Archive />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${entry.name}`}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </EditOnly>
    </li>
  );
}

/**
 * The classes: name, description and where each is used. Rename keeps the id;
 * retire hides it from pickers and refuses new labels (what it labels and
 * approves still counts); delete only when nothing refers to it (409 with
 * counts otherwise), because there is deliberately no force (#395).
 */
export function ClassList({ classes }: { classes: readonly AdminDataClass[] }) {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<{ dataClass: AdminDataClass | null } | null>(null);
  const [retiring, setRetiring] = useState<AdminDataClass | null>(null);
  const [deleting, setDeleting] = useState<AdminDataClass | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ADMIN_DATA_CLASSES_KEY }),
      queryClient.invalidateQueries({ queryKey: ADMIN_CLASSIFICATION_KEY }),
    ]);

  async function remove(entry: AdminDataClass) {
    try {
      await api.delete(`/admin/data-classes/${entry.id}`);
    } catch (cause) {
      // Something was labelled since the page loaded: say what, by the counts.
      if (cause instanceof ApiError && cause.status === 409) {
        const counts = dataClassInUseDetailsSchema.safeParse(cause.details);
        await refresh();
        if (counts.success)
          throw new ApiError(409, cause.code, inUseText(entry.name, counts.data), cause.details);
      }
      throw cause;
    }
    await refresh();
  }

  return (
    <section aria-labelledby="data-classes-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="data-classes-heading" className="text-base font-semibold">
            Classes
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
            A class is a name for a kind of data. There is no ranking: models and connectors are
            approved class by class. Keep the list short, because people see the names.
          </p>
        </div>
        <EditOnly>
          <Button variant="secondary" onClick={() => setFormFor({ dataClass: null })}>
            Add data class
          </Button>
        </EditOnly>
      </div>

      {classes.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="No data classes yet.">
          Add a class such as “Student records”, then approve models for it under Providers &amp;
          Models and say which connectors carry it.
        </EmptyState>
      ) : (
        <ul
          aria-labelledby="data-classes-heading"
          className="m-0 list-none divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)] p-0"
        >
          {classes.map((entry) => (
            <ClassRow
              key={entry.id}
              entry={entry}
              onRename={() => setFormFor({ dataClass: entry })}
              onRetire={() => setRetiring(entry)}
              onDelete={() => setDeleting(entry)}
            />
          ))}
        </ul>
      )}

      <Dialog open={Boolean(formFor)} onOpenChange={(open) => !open && setFormFor(null)}>
        {formFor && (
          <ClassFormDialog dataClass={formFor.dataClass} onClose={() => setFormFor(null)} />
        )}
      </Dialog>

      <ConfirmDialog
        open={Boolean(retiring)}
        onOpenChange={(open) => !open && setRetiring(null)}
        title={`Retire ${retiring?.name ?? 'class'}?`}
        description="It disappears from the label pickers and cannot be added to anything new. Everything it already labels, and every approval for it, still counts."
        confirmLabel="Retire class"
        pendingLabel="Retiring…"
        errorMessage="The class could not be retired."
        onConfirm={async () => {
          if (!retiring) return;
          await api.post(`/admin/data-classes/${retiring.id}/retire`);
          await refresh();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'class'}?`}
        description={
          deleting && inUse(deleting)
            ? inUseText(deleting.name, usageOf(deleting))
            : `${deleting?.modelCount ?? 0} ${deleting?.modelCount === 1 ? 'model is' : 'models are'} approved for it, and that approval goes with it. Nothing is labelled with it. This cannot be undone.`
        }
        confirmLabel="Delete class"
        pendingLabel="Deleting…"
        errorMessage="The class could not be deleted."
        confirmDisabled={Boolean(deleting && inUse(deleting))}
        onConfirm={() => (deleting ? remove(deleting) : Promise.resolve())}
      />
    </section>
  );
}
