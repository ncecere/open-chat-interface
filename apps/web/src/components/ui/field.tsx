import type { ReactNode } from 'react';
import { Label } from '~/components/ui/label';

/** The id of the error shown under the control `id`, which the control points at. */
export const fieldErrorId = (id: string) => `${id}-error`;

/**
 * The `aria-*` a control gets while its field shows `error` (#283): marked
 * invalid, and described by the error under it as well as by anything that
 * already describes it (`describedBy`, such as a config-source badge).
 */
export function invalidFieldProps(id: string, error: string | null, describedBy?: string) {
  const ids = [describedBy, error ? fieldErrorId(id) : undefined].filter(Boolean).join(' ');
  return {
    'aria-invalid': error ? true : undefined,
    'aria-describedby': ids || undefined,
  } as const;
}

/**
 * Label + control + optional hint, used throughout the admin forms. `error`
 * is what is wrong with this field's value, shown under the control and
 * announced, as Branding does; give the control `invalidFieldProps` so it is
 * marked invalid and described by it (#283).
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error && (
        <p
          id={htmlFor ? fieldErrorId(htmlFor) : undefined}
          role="alert"
          className="whitespace-pre-line text-xs text-[var(--danger)]"
        >
          {error}
        </p>
      )}
      {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}
