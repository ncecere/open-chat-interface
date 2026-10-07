import { type AdminUser, USER_ROLES } from '@oci/shared';
import { useState } from 'react';
import { MutationError } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Button } from '~/components/ui/button';
import { Select } from '~/components/ui/select';
import { useCurrentUser } from '~/hooks/use-current-user';
import type { BulkResult, useUserSelection } from './use-user-selection';

const BULK_ACTION_FAILURES: Record<string, string> = {
  set_role: 'The role could not be applied to the selected accounts.',
  revoke_sessions: 'The selected accounts could not be signed out.',
  ban: 'The selected accounts could not be banned.',
};

const plural = (count: number, noun: string) =>
  `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;

function describeAccounts(count: number) {
  return plural(count, 'account');
}

const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);

/** What a finished bulk action did, in the page's words (#145). */
export function bulkResultText(
  variables: { action: string; role?: string } | undefined,
  result: BulkResult,
): string {
  const accounts = describeAccounts(result.affected);
  const sessions =
    result.sessionsEnded === undefined ? '' : `, ending ${plural(result.sessionsEnded, 'session')}`;
  const done =
    variables?.action === 'set_role'
      ? `${roleLabel(variables.role ?? '')} role applied to ${accounts}.`
      : variables?.action === 'ban'
        ? `Banned ${accounts}${sessions}.`
        : variables?.action === 'revoke_sessions'
          ? `Signed out ${accounts}${sessions}.`
          : `Updated ${accounts}.`;
  return result.skippedSelf ? `${done} Your own account was left unchanged.` : done;
}

type Pending = { kind: 'ban' | 'admin' | 'sign-out'; count: number; withSelf: boolean };

export function UserBulkToolbar({ selection }: { selection: ReturnType<typeof useUserSelection> }) {
  const { selected, bulkRole, setBulkRole, bulk, clear } = selection;
  // Your own account is always skipped by the API, so it is not counted in
  // what a confirmation says will change (#145).
  const ownId = useCurrentUser().data?.user.id;
  const withSelf = ownId !== undefined && selected.has(ownId);
  const count = selected.size;
  const others = withSelf ? count - 1 : count;
  // The figures are captured when a dialog opens: a successful action clears
  // the selection while the dialog is still closing. Granting administrator
  // access, banning and signing out ask first; other roles apply at once.
  const [pending, setPending] = useState<Pending | null>(null);
  const open = (kind: Pending['kind']) => setPending({ kind, count: others, withSelf });
  const accounts = describeAccounts(pending?.count ?? others);
  const selfNote = pending?.withSelf
    ? 'Your own account is selected but will be left unchanged.'
    : 'Your own account is never included.';

  return (
    <>
      {count > 0 && (
        <section
          aria-label="Bulk actions"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3"
        >
          <span className="font-medium text-sm">
            {describeAccounts(count)} selected
            {withSelf && (
              <span className="font-normal text-[var(--text-muted)]">
                {' '}
                (including yours, which is left unchanged)
              </span>
            )}
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Select
              aria-label="Role to apply"
              value={bulkRole}
              onChange={(value) => setBulkRole(value as AdminUser['role'])}
              options={USER_ROLES.map((role) => ({ value: role, label: roleLabel(role) }))}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={bulk.isPending || others === 0}
              onClick={() =>
                bulkRole === 'admin'
                  ? open('admin')
                  : bulk.mutate({ action: 'set_role', role: bulkRole })
              }
            >
              Apply role
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={bulk.isPending || others === 0}
              onClick={() => open('sign-out')}
            >
              Sign out
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={bulk.isPending || others === 0}
              onClick={() => open('ban')}
            >
              Ban
            </Button>
            <Button size="sm" variant="ghost" onClick={clear}>
              Clear
            </Button>
          </span>
        </section>
      )}
      {/* The dialogs report their own failure while open. */}
      {pending === null && (
        <MutationError
          error={bulk.error}
          message={
            BULK_ACTION_FAILURES[bulk.variables?.action ?? ''] ??
            'The bulk action could not be completed.'
          }
          className="mb-3"
        />
      )}
      {bulk.data && (
        <p role="status" className="mb-3 text-[var(--text-muted)] text-xs">
          {bulkResultText(bulk.variables, bulk.data)}
        </p>
      )}

      <ConfirmDialog
        open={pending?.kind === 'ban'}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        title={`Ban ${accounts}?`}
        description={`Banned accounts are signed out and cannot sign in again until an administrator lifts the ban. ${selfNote}`}
        confirmLabel={`Ban ${accounts}`}
        pendingLabel="Banning…"
        errorMessage={BULK_ACTION_FAILURES.ban ?? ''}
        onConfirm={() => bulk.mutateAsync({ action: 'ban' })}
      />

      <ConfirmDialog
        open={pending?.kind === 'admin'}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        title={
          (pending?.count ?? others) === 1
            ? 'Make 1 account an administrator?'
            : `Make ${accounts} administrators?`
        }
        description={`Administrators can see and change every setting, manage every account (including other administrators), and read the audit log. ${selfNote}`}
        confirmLabel={`Make ${accounts} administrators`}
        pendingLabel="Applying…"
        errorMessage={BULK_ACTION_FAILURES.set_role ?? ''}
        onConfirm={() => bulk.mutateAsync({ action: 'set_role', role: 'admin' })}
      />

      <ConfirmDialog
        open={pending?.kind === 'sign-out'}
        onOpenChange={(isOpen) => !isOpen && setPending(null)}
        title={`Sign ${accounts} out everywhere?`}
        description={`This ends every session of the selected accounts. They can sign in again straight away. ${selfNote}`}
        confirmLabel={`Sign out ${accounts}`}
        pendingLabel="Signing out…"
        errorMessage={BULK_ACTION_FAILURES.revoke_sessions ?? ''}
        onConfirm={() => bulk.mutateAsync({ action: 'revoke_sessions' })}
      />
    </>
  );
}
