/**
 * A sign-in, sign-up or reset form's error. Announced when it appears
 * (`role="alert"`, WCAG 4.1.3), and given an id so the fields it concerns can
 * point at it with `aria-describedby` (WCAG 3.3.1). It was a plain paragraph,
 * which screen readers did not read out (#183).
 */
export function AuthFormError({ id, children }: { id: string; children: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
    >
      {children}
    </p>
  );
}

/** The `aria-*` a field gets while the form shows `error`. */
export function fieldErrorProps(errorId: string, error: string | null, invalid = Boolean(error)) {
  return {
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
  } as const;
}
