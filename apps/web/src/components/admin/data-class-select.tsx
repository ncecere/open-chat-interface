import type { AdminDataClass } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useId } from 'react';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

/** Every data class with where it is used, for the Data classes page and the pickers on Models and Connectors. */
export const ADMIN_DATA_CLASSES_KEY = ['admin', 'data-classes'] as const;

export function useAdminDataClasses() {
  return useQuery({
    queryKey: ADMIN_DATA_CLASSES_KEY,
    queryFn: () => api.get<{ classes: AdminDataClass[] }>('/admin/data-classes'),
    select: (data) => data.classes,
  });
}

/**
 * A group of checkboxes, one per data class (#395). Retired classes still
 * count for enforcement, so one that is chosen stays visible to be unchosen;
 * an unchosen retired class is not offered.
 *
 * `emptyText` says what none chosen means ("No class: this model cannot
 * receive labelled content"), since for approvals the empty list is a
 * decision, not an omission.
 */
export function DataClassSelect({
  legend,
  classes,
  value,
  onChange,
  emptyText,
  hint,
  disabled = false,
  extra,
  error,
}: {
  legend: string;
  classes: readonly AdminDataClass[] | undefined;
  value: readonly string[];
  onChange: (ids: string[]) => void;
  /** Shown while nothing is chosen. */
  emptyText: string;
  hint?: string;
  disabled?: boolean;
  /** More below the checkboxes, such as "Carries no classified data". */
  extra?: ReactNode;
  error?: string | null;
}) {
  const statusId = useId();
  const errorId = useId();
  if (!classes) return null;
  const offered = classes.filter((entry) => !entry.retiredAt || value.includes(entry.id));
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...value, id]);

  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      aria-describedby={[statusId, error ? errorId : undefined].filter(Boolean).join(' ')}
      aria-invalid={error ? true : undefined}
    >
      <legend className="mb-1 text-sm font-medium text-[var(--text-primary)]">{legend}</legend>
      {offered.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          No data classes are defined yet. Add some under{' '}
          <Link to="/admin/data-classes" className="underline">
            Data classes
          </Link>
          .
        </p>
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {offered.map((entry) => {
            const checked = value.includes(entry.id);
            return (
              <label
                key={entry.id}
                className={cn(
                  'flex min-h-6 cursor-pointer items-center gap-2 text-sm',
                  disabled && 'cursor-default opacity-60',
                )}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(entry.id)}
                />
                <span>
                  {entry.name}
                  {entry.retiredAt && (
                    <span className="ms-1 text-xs text-[var(--text-muted)]">(retired)</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}
      {extra}
      <p id={statusId} className="text-xs text-[var(--text-muted)]">
        {value.length === 0
          ? emptyText
          : `${value.length} ${value.length === 1 ? 'class' : 'classes'} chosen.`}
        {hint ? ` ${hint}` : ''}
      </p>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </fieldset>
  );
}
