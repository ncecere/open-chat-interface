import { type AdminUser, USER_ROLES } from '@oci/shared';
import { useState } from 'react';
import { MutationError } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Button } from '~/components/ui/button';
import { Select } from '~/components/ui/select';
import type { useUserSelection } from './use-user-selection';

const BULK_ACTION_FAILURES: Record<string, string> = {
  set_role: 'The role could not be applied to the selected accounts.',
  revoke_sessions: 'The selected accounts could not be signed out.',
  ban: 'The selected accounts could not be banned.',
};

function describeAccounts(count: number) {
  return `${count} account${count === 1 ? '' : 's'}`;
}

export function UserBulkToolbar({ selection }: { selection: ReturnType<typeof useUserSelection> }) {
  const { selected, bulkRole, setBulkRole, bulk, clear } = selection;
  // The count is captured when the dialog opens: a successful ban clears the
  // selection while the dialog is still closing.
  const [banCount, setBanCount] = useState<number | null>(null);
  // Granting administrator access asks first, as the per-account role
  // selector does; other roles apply at once.
  const [adminCount, setAdminCount] = useState<number | null>(null);
  const count = selected.size;
  const banAccounts = describeAccounts(banCount ?? count);
  const adminAccounts = describeAccounts(adminCount ?? count);

  return (
    <>
      {count > 0 && (
        <section
          aria-label="Bulk actions"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3"
        >
          <span className="font-medium text-sm">{describeAccounts(count)} selected</span>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Select
              aria-label="Role to apply"
              value={bulkRole}
              onChange={(value) => setBulkRole(value as AdminUser['role'])}
              options={USER_ROLES.map((role) => ({
                value: role,
                label: role.charAt(0).toUpperCase() + role.slice(1),
              }))}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={bulk.isPending}
              onClick={() =>
                bulkRole === 'admin'
                  ? setAdminCount(count)
                  : bulk.mutate({ action: 'set_role', role: bulkRole })
              }
            >
              Apply role
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={bulk.isPending}
              onClick={() => bulk.mutate({ action: 'revoke_sessions' })}
            >
              Sign out
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={bulk.isPending}
              onClick={() => setBanCount(count)}
            >
              Ban
            </Button>
            <Button size="sm" variant="ghost" onClick={clear}>
              Clear
            </Button>
          </span>
        </section>
      )}
      {/* The ban and admin dialogs report their own failure while open. */}
      {banCount === null && adminCount === null && (
        <MutationError
          error={bulk.error}
          message={
            BULK_ACTION_FAILURES[bulk.variables?.action ?? ''] ??
            'The bulk action could not be completed.'
          }
          className="mb-3"
        />
      )}
      {bulk.data?.skippedSelf && (
        <p className="mb-3 text-[var(--text-muted)] text-xs">
          Your own account was left unchanged.
        </p>
      )}

      <ConfirmDialog
        open={banCount !== null}
        onOpenChange={(open) => !open && setBanCount(null)}
        title={`Ban ${banAccounts}?`}
        description="Banned accounts are signed out and cannot sign in again until an administrator lifts the ban. Your own account is never included."
        confirmLabel={`Ban ${banAccounts}`}
        pendingLabel="Banning…"
        errorMessage={BULK_ACTION_FAILURES.ban ?? ''}
        onConfirm={() => bulk.mutateAsync({ action: 'ban' })}
      />

      <ConfirmDialog
        open={adminCount !== null}
        onOpenChange={(open) => !open && setAdminCount(null)}
        title={`Make ${adminAccounts} administrators?`}
        description="Administrators can see and change every setting, manage every account (including other administrators), and read the audit log. Your own account is never included."
        confirmLabel={`Make ${adminAccounts} administrators`}
        pendingLabel="Applying…"
        errorMessage={BULK_ACTION_FAILURES.set_role ?? ''}
        onConfirm={() => bulk.mutateAsync({ action: 'set_role', role: 'admin' })}
      />
    </>
  );
}
