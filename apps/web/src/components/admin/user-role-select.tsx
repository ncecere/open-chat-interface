import { type AdminUser, USER_ROLES, type UserRole } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { MutationError } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Select } from '~/components/ui/select';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  auditor: 'Auditor',
  user: 'User',
  restricted: 'Restricted',
};

const ROLE_OPTIONS = USER_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

/** The listing and every account page read from this prefix. */
export const ADMIN_USERS_QUERY_KEY = ['admin', 'users'] as const;

/** Granting or removing administrator access is confirmed; other changes are not. */
export function roleChangeNeedsConfirmation(from: UserRole, to: UserRole): boolean {
  return from !== to && (from === 'admin' || to === 'admin');
}

function confirmationCopy(name: string, to: UserRole) {
  if (to === 'admin') {
    return {
      title: `Make ${name} an administrator?`,
      description:
        'Administrators can change every setting, manage every account including yours, and read the audit log.',
      confirmLabel: 'Make administrator',
    };
  }
  return {
    title: `Remove administrator access from ${name}?`,
    description:
      to === 'auditor'
        ? `${name} will become an auditor: they can still view administration but no longer change it.`
        : `${name} will become ${to === 'user' ? 'a user' : 'a restricted user'} and lose access to administration.`,
    confirmLabel: 'Remove administrator access',
  };
}

/**
 * A compact role picker for one account. Changes that grant or remove
 * administrator access go through a confirmation first; the server's reason
 * for rejecting a change (such as removing your own administrator role) is
 * shown beside the control or inside the dialog.
 */
export function UserRoleSelect({
  user,
  className,
}: {
  user: Pick<AdminUser, 'id' | 'name' | 'email' | 'role'>;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [confirmRole, setConfirmRole] = useState<UserRole | null>(null);
  const name = user.name || user.email;
  const noteId = useId();
  // The server refuses to remove your own administrator role, and for an
  // administrator any change does. Say so beside the control instead of
  // offering a confirmation about yourself in the third person that then
  // fails (#76).
  const ownAdminRole = useCurrentUser().data?.user.id === user.id && user.role === 'admin';

  async function applyRole(role: UserRole) {
    await api.patch(`/admin/users/${user.id}`, { role });
    await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
  }

  const change = useMutation({ mutationFn: applyRole });

  function select(value: string) {
    const role = value as UserRole;
    if (role === user.role) return;
    if (roleChangeNeedsConfirmation(user.role, role)) {
      change.reset();
      setConfirmRole(role);
      return;
    }
    change.mutate(role);
  }

  const copy = confirmRole ? confirmationCopy(name, confirmRole) : null;
  // Show the requested role while the change is in flight.
  const shown = change.isPending && change.variables ? change.variables : user.role;

  return (
    <>
      <Select
        aria-label={`Role for ${user.email}`}
        value={shown}
        onChange={select}
        options={ROLE_OPTIONS}
        disabled={change.isPending || ownAdminRole}
        aria-describedby={ownAdminRole ? noteId : undefined}
        className={cn('h-8 w-32', className)}
      />
      {ownAdminRole && (
        <p
          id={noteId}
          className="mt-1 basis-full whitespace-normal text-xs text-[var(--text-muted)]"
        >
          You cannot remove your own administrator role. Ask another administrator.
        </p>
      )}
      <MutationError
        error={change.error}
        message="The role could not be changed."
        className="mt-1 basis-full whitespace-normal text-xs"
      />
      <ConfirmDialog
        open={confirmRole !== null}
        onOpenChange={(open) => !open && setConfirmRole(null)}
        title={copy?.title ?? ''}
        description={copy?.description ?? ''}
        confirmLabel={copy?.confirmLabel ?? 'Change role'}
        pendingLabel="Changing role…"
        errorMessage="The role could not be changed."
        onConfirm={() => (confirmRole ? applyRole(confirmRole) : Promise.resolve())}
      />
    </>
  );
}
