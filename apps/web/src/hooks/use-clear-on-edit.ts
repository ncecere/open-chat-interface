import { type RefObject, useEffect, useRef, useState } from 'react';

/**
 * Clears a form's error once the form changes (#178, #217).
 *
 * A validation or save error is about the values that were submitted. Once
 * any of them changes it may no longer hold, so it goes, and the next attempt
 * reports afresh. Left on screen it contradicted the corrected field, and on
 * a settings page whose corrected form matched what was saved (Save
 * disabled) it stayed indefinitely.
 *
 * `values` is everything the form submits; it is compared by content, so a
 * new object with the same values is not an edit. `clear` resets whatever
 * holds the error: a local message, a mutation (`mutation.reset()`), or both.
 * It is told which of `values`' keys changed, so a form that lists several
 * problems can drop only those about the edited field (#257); see
 * `useFieldProblems`. Use it in every form that keeps an error from its last
 * attempt.
 */
export function useClearOnEdit(values: unknown, clear: (changed: string[]) => void): void {
  const key = JSON.stringify(values);
  const previous = useRef({ key, values });
  const latestClear = useRef(clear);
  latestClear.current = clear;
  // `key` stands for the content; the values themselves are read from here.
  const latestValues = useRef(values);
  latestValues.current = values;

  useEffect(() => {
    if (previous.current.key === key) return;
    const changed = changedKeys(previous.current.values, latestValues.current);
    previous.current = { key, values: latestValues.current };
    latestClear.current(changed);
  }, [key]);
}

/** The keys whose values differ by content; every key when either is not a plain object. */
export function changedKeys(before: unknown, after: unknown): string[] {
  const record = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const a = record(before);
  const b = record(after);
  if (!a || !b) return ['*'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/**
 * One problem with what was submitted, and the form fields (keys of the
 * form's values) it is about. A problem with no fields is about the whole
 * attempt, such as a save that failed.
 */
export interface FieldProblem {
  fields: readonly string[];
  text: string;
}

/**
 * The problems still standing after an edit to `changed`: one about only
 * fields left untouched stays, so the person correcting a list of mistakes
 * keeps the rest of the list (#257). One about an edited field goes, and so
 * does one about no field, or a field the form does not have, since the edit
 * may have answered it; the next attempt reports afresh.
 */
export function problemsAfterEdit(
  problems: readonly FieldProblem[],
  changed: readonly string[],
  formKeys: readonly string[],
): FieldProblem[] {
  return problems.filter(
    (problem) =>
      problem.fields.length > 0 &&
      problem.fields.every((field) => formKeys.includes(field) && !changed.includes(field)),
  );
}

/** The problems as one message (each sentence once), or null when there are none. */
export function problemsText(problems: readonly FieldProblem[], separator = ' '): string | null {
  if (problems.length === 0) return null;
  return [...new Set(problems.map(({ text }) => text))].join(separator);
}

/**
 * Each problem about a key of `linked` also made about the fields listed for
 * it, which decide it too: "Use an https:// address" is about the URL, but
 * switching on "Allow private network" answers it as well, so either edit
 * clears it (#283). It is still shown at its own field, the first.
 */
export function linkFields(
  problems: readonly FieldProblem[],
  linked: Readonly<Record<string, readonly string[]>>,
): FieldProblem[] {
  return problems.map((problem) => {
    const extra = problem.fields.flatMap((field) => linked[field] ?? []);
    return extra.length > 0 ? { ...problem, fields: [...problem.fields, ...extra] } : problem;
  });
}

/**
 * The problems a form shows under `field` (#283): those it is the first field
 * of, so a problem about the URL and the switch that allows plain http:// is
 * shown once, at the URL. One message, or null when there are none.
 */
export function problemsAt(problems: readonly FieldProblem[], field: string): string | null {
  return problemsText(
    problems.filter((problem) => problem.fields[0] === field),
    '\n',
  );
}

/**
 * The problems shown at none of the fields in `shown`: about the whole
 * attempt (a save that failed), or a field the form has no place for. These
 * stay at the foot of the form (#283).
 */
export function problemsElsewhere(
  problems: readonly FieldProblem[],
  shown: readonly string[],
): string | null {
  return problemsText(
    problems.filter((problem) => !shown.includes(problem.fields[0] ?? '')),
    '\n',
  );
}

/**
 * A form's list of problems from its last attempt, each dropped once a field
 * it is about changes (#178, #217, #257). `values` is what the form submits,
 * as an object keyed by field.
 *
 * With `form`, the first field marked invalid (`aria-invalid`) is scrolled
 * into view after an attempt that found problems: in a long dialog the field
 * may be far above the Save button that was pressed (#283).
 */
export function useFieldProblems(
  values: object,
  form?: RefObject<HTMLElement | null>,
): [FieldProblem[], (problems: FieldProblem[]) => void] {
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [attempts, setAttempts] = useState(0);
  const formKeys = Object.keys(values);
  useClearOnEdit(values, (changed) =>
    setProblems((current) =>
      current.length === 0 ? current : problemsAfterEdit(current, changed, formKeys),
    ),
  );
  useEffect(() => {
    if (attempts === 0) return;
    const invalid = form?.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    invalid?.scrollIntoView?.({ block: 'nearest' });
  }, [attempts, form]);
  const report = (next: FieldProblem[]) => {
    setProblems(next);
    if (next.length > 0) setAttempts((count) => count + 1);
  };
  return [problems, report];
}
