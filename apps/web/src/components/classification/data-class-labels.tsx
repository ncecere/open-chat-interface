import type { ClassificationClass, DataClass } from '@oci/shared';
import { Plus, ShieldAlert, X } from 'lucide-react';
import { useId } from 'react';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { FOCUS_RING } from '~/components/ui/focus-ring';
import { apiErrorMessage } from '~/lib/api-client';
import { reasonTexts, whyNotRemovable } from '~/lib/classification';
import { useReadOnlyLock } from '~/lib/read-only';
import { cn } from '~/lib/utils';

/**
 * The data classes a conversation or project carries, each with its reason,
 * and the control to add or remove the ones a person may change (#395).
 *
 * A class can be removed only by whoever may change what gave it: a person
 * removes the labels they added; those from a project, a connector or kept
 * from before are explained instead, in words rather than a dead control.
 */
export function DataClassLabels({
  scope,
  classes,
  addable,
  onAdd,
  onRemove,
  pending = false,
  error = null,
  className,
}: {
  scope: 'thread' | 'project';
  classes: readonly ClassificationClass[];
  /** Classes that can still be added (not retired, not already carried). */
  addable: readonly DataClass[];
  onAdd: (classId: string) => void;
  onRemove: (classId: string) => void;
  /** A change is being saved. */
  pending?: boolean;
  error?: unknown;
  className?: string;
}) {
  const noteId = useId();
  // Labelling changes the conversation: off while read-only, with the reason (#331).
  const lock = useReadOnlyLock();
  const removable = (entry: ClassificationClass) =>
    scope === 'project' ? !entry.locked : Boolean(entry.removable);
  const fixed = classes.filter((entry) => !removable(entry));

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <ul
          aria-label="Data classes"
          className="m-0 flex list-none flex-wrap items-center gap-2 p-0"
        >
          {classes.map((entry) => {
            const canRemove = removable(entry);
            return (
              <li
                key={entry.id}
                data-class-chip={entry.name}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-control)] py-0.5 ps-2.5 pe-2 text-xs"
              >
                <ShieldAlert className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                <span className="font-semibold text-[var(--text-primary)]">{entry.name}</span>
                <span className="text-[var(--text-muted)]">
                  <span aria-hidden="true">· </span>
                  {reasonTexts(entry, scope).join(', ')}
                </span>
                {canRemove ? (
                  <button
                    type="button"
                    aria-label={`Remove the ${entry.name} label`}
                    aria-disabled={lock.title ? true : undefined}
                    title={lock.title}
                    disabled={pending && !lock.title}
                    onClick={() => {
                      if (!lock.title) onRemove(entry.id);
                    }}
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
                      FOCUS_RING,
                    )}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                ) : (
                  <span className="sr-only">. {whyNotRemovable(entry, scope)}</span>
                )}
              </li>
            );
          })}
        </ul>

        {addable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Add label"
                locked={lock.title}
                disabled={pending}
                className="h-7 gap-1 rounded-full px-2.5 text-xs"
              >
                <Plus aria-hidden />
                Add label
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" aria-label="Data classes you can add">
              {addable.map((entry) => (
                <DropdownMenuItem key={entry.id} onSelect={() => onAdd(entry.id)}>
                  {entry.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {fixed.length > 0 && (
        <p id={noteId} className="m-0 text-xs text-[var(--text-muted)]">
          {scope === 'project'
            ? 'Labels an administrator set stay until an administrator removes them.'
            : 'Labels that come from the project or a connector cannot be removed here; change the project’s labels to remove those.'}
        </p>
      )}
      {error ? (
        <p role="alert" className="m-0 text-xs text-[var(--danger-on-tint)]">
          {apiErrorMessage(error, 'The label could not be changed.')}
        </p>
      ) : null}
    </div>
  );
}
