import { type AdminUser, USER_ROLES } from '@oci/shared';
import { Button } from '~/components/ui/button';
import { Select } from '~/components/ui/select';
import type { useUserSelection } from './use-user-selection';

export function UserBulkToolbar({ selection }: { selection: ReturnType<typeof useUserSelection> }) {
  const { selected, bulkRole, setBulkRole, bulk, clear } = selection;
  return (
    <>
      {selected.size > 0 && (
        <section
          aria-label="Bulk actions"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3"
        >
          <span className="font-medium text-sm">
            {selected.size} account{selected.size === 1 ? '' : 's'} selected
          </span>
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
              onClick={() => bulk.mutate({ action: 'set_role', role: bulkRole })}
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
              onClick={() => bulk.mutate({ action: 'ban' })}
            >
              Ban
            </Button>
            <Button size="sm" variant="ghost" onClick={clear}>
              Clear
            </Button>
          </span>
        </section>
      )}
      {bulk.data?.skippedSelf && (
        <p className="mb-3 text-[var(--text-muted)] text-xs">
          Your own account was left unchanged.
        </p>
      )}
    </>
  );
}
