import { type AdminUser, USER_ROLES } from '@oci/shared';
import { useSearch } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { useAdminAccess } from '~/components/admin/admin-access';
import { AdminPageHeader, EmptyState, LoadError } from '~/components/admin/admin-ui';
import { QuotaOverrideDialog } from '~/components/admin/quota-override-dialog';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { FullPageSpinner } from '~/components/ui/spinner';
import { UserBulkToolbar } from './users/bulk-toolbar';
import { PAGE_SIZE } from './users/directory-filters';
import { SavedUserViews, useSavedUserViews } from './users/saved-views';
import { useUserDirectory } from './users/use-user-directory';
import { useUserSelection } from './users/use-user-selection';
import { UserTable } from './users/user-table';

const STATUS_OPTIONS = [
  { value: 'all', label: 'Any status' },
  { value: 'active', label: 'Not banned' },
  { value: 'banned', label: 'Banned' },
  { value: 'unverified', label: 'Unverified email' },
] as const;

export function AdminUsersPage() {
  const { role: initialRole } = useSearch({ strict: false }) as { role?: AdminUser['role'] };
  const directory = useUserDirectory(initialRole);
  const views = useSavedUserViews(directory, directory.applyFilters);
  const selection = useUserSelection(directory.data?.users.map((user) => user.id) ?? []);
  const { canEdit } = useAdminAccess();
  const [limitsFor, setLimitsFor] = useState<AdminUser | null>(null);
  const { data, isLoading, search, role, status, sort, direction, page, total, pageCount } =
    directory;

  return (
    <div>
      <AdminPageHeader
        title="Users"
        // Nothing while the list has failed: "Loading accounts..." stayed
        // beside the error, saying two things at once (#245).
        description={
          data
            ? `${data.total} account${data.total === 1 ? '' : 's'}`
            : isLoading
              ? 'Loading accounts...'
              : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Search by name or email..."
          className="max-w-sm"
          value={search}
          onChange={(event) => directory.changeFilter('search', event.target.value)}
        />
        <Select
          value={role}
          onChange={(value) => directory.changeFilter('role', value)}
          aria-label="Filter by role"
          className="w-40"
          options={[
            { value: 'all', label: 'Any role' },
            ...USER_ROLES.map((option) => ({
              value: option,
              label: option.charAt(0).toUpperCase() + option.slice(1),
            })),
          ]}
        />
        <Select
          value={status}
          onChange={(value) => directory.changeFilter('status', value)}
          aria-label="Filter by status"
          className="w-44"
          options={[...STATUS_OPTIONS]}
        />
      </div>

      {isLoading ? (
        <div className="py-16">
          <FullPageSpinner />
        </div>
      ) : !data ? (
        <LoadError title="Accounts could not be loaded." query={directory.query} className="mt-6" />
      ) : (
        <div className="mt-6">
          {/* Saving a view and bulk changes are writes; auditors only browse. */}
          {canEdit && <SavedUserViews views={views} />}
          {canEdit && <UserBulkToolbar selection={selection} />}
          {data.users.length === 0 ? (
            // Bare column headers read as a broken table; say nothing matched.
            <div className="flex flex-col items-center gap-3">
              <EmptyState icon={Users} title="No accounts match these filters.">
                Try another search, or clear the filters to see everyone.
              </EmptyState>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  directory.changeFilter('search', '');
                  directory.changeFilter('role', 'all');
                  directory.changeFilter('status', 'all');
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <UserTable
              users={data.users}
              sort={sort}
              direction={direction}
              onSort={directory.toggleSort}
              selection={selection}
              onLimits={setLimitsFor}
            />
          )}
        </div>
      )}

      {total > PAGE_SIZE && (
        <nav aria-label="User list pages" className="mt-4 flex items-center justify-between gap-4">
          <p aria-live="polite" className="text-[var(--text-muted)] text-sm">
            Showing {directory.firstOnPage}–{directory.lastOnPage} of {total}
          </p>

          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={page === 0}
              onClick={directory.previousPage}
            >
              Previous
            </Button>
            <span className="text-[var(--text-muted)] text-sm">
              Page {page + 1} of {pageCount}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page + 1 >= pageCount}
              onClick={directory.nextPage}
            >
              Next
            </Button>
          </span>
        </nav>
      )}

      <Dialog open={Boolean(limitsFor)} onOpenChange={(open) => !open && setLimitsFor(null)}>
        {limitsFor && <QuotaOverrideDialog user={limitsFor} onClose={() => setLimitsFor(null)} />}
      </Dialog>
    </div>
  );
}
