import { useBlocker } from '@tanstack/react-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Admin pages hold edits in local drafts (Roles has five or six Save buttons),
 * and leaving the page, switching a role tab or closing the browser tab threw
 * them away without a word (#45). Each form reports whether it has unsaved
 * changes; while any does, the admin layout asks before navigating away, and
 * the browser asks before the tab is closed or reloaded. The settings layout
 * guards a person's own settings the same way (#314).
 */
export const LEAVE_WITH_UNSAVED_CHANGES =
  'You have unsaved changes on this page. Leave without saving them?';

interface UnsavedChangesContextValue {
  report: (id: string, dirty: boolean) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

export function UnsavedChangesGuard({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const report = useCallback((id: string, isDirty: boolean) => {
    setDirty((current) => {
      if (current.has(id) === isDirty) return current;
      const next = new Set(current);
      if (isDirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const hasUnsaved = dirty.size > 0;

  useBlocker({
    // Blocks unless the person agrees to discard; one question for the page,
    // however many sections have changes.
    shouldBlockFn: () => !window.confirm(LEAVE_WITH_UNSAVED_CHANGES),
    disabled: !hasUnsaved,
    enableBeforeUnload: hasUnsaved,
  });

  const value = useMemo(() => ({ report }), [report]);
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

/**
 * Whether `values` differ, by content, from what they were when the form was
 * opened. A dialog form passes it to DialogContent's `confirmDiscard`, so
 * Escape or a click outside asks before throwing its edits away (#45, #300).
 * `values` must be JSON (a Set is passed as an array).
 */
export function useEditedSince(values: unknown): boolean {
  const [initial] = useState(() => JSON.stringify(values));
  return JSON.stringify(values) !== initial;
}

/**
 * Tells the admin or settings layout whether this form has unsaved changes.
 * Every form with a Save button there calls it (#300, #314): one that did not
 * lost its edit without a word when the person left the page.
 */
export function useReportUnsaved(dirty: boolean): void {
  const context = useContext(UnsavedChangesContext);
  const id = useId();
  const report = useRef(context?.report);
  report.current = context?.report;
  useEffect(() => {
    report.current?.(id, dirty);
  }, [id, dirty]);
  // A form that goes away (its section closed, its tab left) has nothing left to lose.
  useEffect(() => () => report.current?.(id, false), [id]);
}
