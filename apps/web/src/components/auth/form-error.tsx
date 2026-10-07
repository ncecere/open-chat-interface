import { Fragment, type ReactNode, useEffect, useRef } from 'react';

/**
 * A sign-in, sign-up or reset form's error. Announced when it appears
 * (`role="alert"`, WCAG 4.1.3), and given an id so the fields it concerns can
 * point at it with `aria-describedby` (WCAG 3.3.1). It was a plain paragraph,
 * which screen readers did not read out (#183).
 */
export function AuthFormError({
  id,
  children,
  messages,
}: {
  id: string;
  children: string;
  /**
   * The form's own check, one message per field at fault. The alert is still
   * one message, read once, but each part has an id so the field it is about
   * can be described by that part alone, not the whole (#338).
   */
  messages?: FieldMessage[];
}) {
  return (
    <p
      id={id}
      role="alert"
      className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
    >
      {messages && messages.length > 0
        ? messages.map((message, index) => (
            <Fragment key={message.id}>
              {index > 0 && ' '}
              <span id={`${id}-${message.id}`}>{message.text}</span>
            </Fragment>
          ))
        : children}
    </p>
  );
}

/** What the form's own check found wrong with one field. */
export interface FieldMessage {
  /** The field's id. */
  id: string;
  text: string;
}

/**
 * The `aria-*` a field gets while its form shows `error`, for a form whose
 * own check can fault several fields at once (#338). Each field is described
 * by its own part of the message, not the whole of it: a screen reader
 * focusing Email read the password's complaint too. An error from elsewhere
 * (the server, a wrong password) has no parts and describes every field.
 * The field's hint (`hintId`) goes with it, except where the message already
 * states it (`hintRestated`: "Use at least 12 characters for your password."
 * beside "Use at least 12 characters." was read twice).
 */
export function authFieldProps({
  errorId,
  error,
  messages = [],
  fieldId,
  invalid,
  hintId,
  hintRestated = false,
}: {
  errorId: string;
  error: string | null;
  messages?: FieldMessage[];
  fieldId: string;
  invalid?: boolean;
  hintId?: string;
  hintRestated?: boolean;
}) {
  const own = messages.some((message) => message.id === fieldId);
  const split = messages.length > 0;
  // By default a field is marked invalid when the form's own check faulted it.
  const errorRef = !error
    ? undefined
    : split
      ? own
        ? `${errorId}-${fieldId}`
        : undefined
      : errorId;
  const hintRef = own && hintRestated ? undefined : hintId;
  return {
    'aria-invalid': (invalid ?? own) ? true : undefined,
    'aria-describedby': [errorRef, hintRef].filter(Boolean).join(' ') || undefined,
  } as const;
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

/** One field's check: its id, and what is wrong with it or null. */
export interface AuthFieldCheck {
  id: string;
  problem: string | null;
}

/**
 * Every empty or malformed field of an auth form, at once and in the app's
 * words. The forms set noValidate: the browser's own bubble stopped at the
 * first `required` or `type="email"` field, in its own language, and went on
 * the next click without marking the field (#320's sweep). Null when there
 * are none; otherwise the message for the form's error, and the fields it
 * is about (marked invalid and described by it).
 */
export function authFormProblems(
  checks: readonly AuthFieldCheck[],
): { ids: string[]; message: string; messages: FieldMessage[] } | null {
  const failing = checks.filter((check) => check.problem);
  if (failing.length === 0) return null;
  return {
    ids: failing.map((check) => check.id),
    message: failing.map((check) => check.problem).join(' '),
    messages: failing.map((check) => ({ id: check.id, text: check.problem as string })),
  };
}

const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What is wrong with a typed email address, or null. */
export function emailProblem(email: string): string | null {
  if (!email.trim()) return 'Enter your email address.';
  return EMAIL_ADDRESS.test(email.trim())
    ? null
    : 'Enter an email address such as you@example.com.';
}

/** What is wrong with a new password's length, or null (the instance's rule: 12 to 200). */
export function newPasswordProblem(password: string): string | null {
  return password.length < 12 ? 'Use at least 12 characters for your password.' : null;
}
