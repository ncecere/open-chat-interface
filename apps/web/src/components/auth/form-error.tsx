import { type ReactNode, useEffect, useRef } from 'react';

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

/**
 * The `aria-*` a field gets while the form shows `error`, and always the
 * field's own hint (`hintId`, such as "Use at least 12 characters."), which
 * was a bare paragraph after it that screen readers did not read with it
 * (#295).
 */
export function fieldErrorProps(
  errorId: string,
  error: string | null,
  invalid = Boolean(error),
  hintId?: string,
) {
  return {
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby':
      [error ? errorId : undefined, hintId].filter(Boolean).join(' ') || undefined,
  } as const;
}

/**
 * Focus for after a refused submit (#190). The submit button is disabled while
 * the request runs, and a focused control that becomes disabled loses focus
 * to the body, so a keyboard or screen-reader user was left nowhere. Call the
 * returned function with the id of the field at fault, or of the submit
 * button; focus moves there once the page has re-rendered and re-enabled it.
 */
export function useFocusAfterRender(): (id: string) => void {
  const pending = useRef<string | null>(null);
  // After every render: the one that follows the refusal re-enables the form.
  useEffect(() => {
    const id = pending.current;
    if (!id) return;
    const element = document.getElementById(id);
    if (!element || (element as HTMLButtonElement).disabled) return;
    pending.current = null;
    element.focus();
  });
  return (id) => {
    pending.current = id;
  };
}

/**
 * The heading of what a submit led to ("Check your email", "Reset link
 * unavailable"), which replaces the form (#190). The focused control went with
 * the form, so focus moved to the body and a screen reader said nothing; the
 * heading takes focus instead, read with the message it names (`describedBy`).
 * Only after a submit (`focus`): a page opened in that state starts as usual.
 */
export function AuthOutcomeHeading({
  children,
  focus,
  describedBy,
}: {
  children: ReactNode;
  focus: boolean;
  describedBy?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <h1
      ref={ref}
      tabIndex={-1}
      aria-describedby={describedBy}
      className="text-lg font-semibold outline-none"
    >
      {children}
    </h1>
  );
}
