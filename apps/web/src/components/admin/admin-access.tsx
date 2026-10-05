import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useReadOnlyStatus } from '~/lib/read-only';
import { cn } from '~/lib/utils';

/** Shown on every admin page to a read-only viewer. */
export const READ_ONLY_MESSAGE =
  'Read-only access — you can view administration but not change it.';

export type AdminRole = 'admin' | 'auditor';

export interface AdminAccess {
  role: AdminRole;
  /**
   * False for auditors (the API allows them to read but rejects every write)
   * and, for everyone, while the instance is in read-only maintenance mode
   * (v0.11), apart from the read-only switch itself on System health.
   */
  canEdit: boolean;
  /** Read-only maintenance mode is on: changes are paused for administrators too. */
  maintenance: boolean;
}

// Outside the admin layout (unit tests, isolated renders) nothing is
// restricted, matching the router guard that only lets admins and auditors in.
const AdminAccessContext = createContext<AdminAccess>({
  role: 'admin',
  canEdit: true,
  maintenance: false,
});

export function AdminAccessProvider({ role, children }: { role: AdminRole; children: ReactNode }) {
  const maintenance = useReadOnlyStatus().active;
  const value = useMemo<AdminAccess>(
    () => ({ role, canEdit: role === 'admin' && !maintenance, maintenance }),
    [role, maintenance],
  );
  return <AdminAccessContext.Provider value={value}>{children}</AdminAccessContext.Provider>;
}

export function useAdminAccess(): AdminAccess {
  return useContext(AdminAccessContext);
}

/** Renders its children only for someone allowed to change administration. */
export function EditOnly({ children }: { children: ReactNode }) {
  const { canEdit } = useAdminAccess();
  return canEdit ? children : null;
}

/**
 * Disables every native control inside it for a read-only viewer.
 *
 * A disabled fieldset disables nested buttons, inputs, selects and textareas
 * (including Radix switches and select triggers, which render buttons) while
 * leaving links and text readable. Pointer events are also dropped on the
 * disabled buttons, because some primitives open on pointerdown.
 */
export function EditableFieldset({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { canEdit } = useAdminAccess();
  return (
    <fieldset
      disabled={!canEdit}
      className={cn('m-0 min-w-0 border-0 p-0 [&_button:disabled]:pointer-events-none', className)}
    >
      {children}
    </fieldset>
  );
}
