import type { AdminUser } from '@oci/shared';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useAdminAccess } from '~/components/admin/admin-access';
import { ROLE_LABELS, UserRoleSelect } from '~/components/admin/user-role-select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { formatRelativeTime } from '~/lib/utils';
import type { SortKey } from './directory-filters';
import type { useUserSelection } from './use-user-selection';

const ROLE_VARIANT = {
  admin: 'accent',
  auditor: 'accent',
  user: 'neutral',
  restricted: 'outline',
} as const;

/**
 * An address that may break at its `@` and dots, so a narrow column wraps
 * "walk8-target@" / "example.com", not "walk8- / target@example. / com"
 * (#334). A word-break opportunity adds no text, so the name read is the
 * address. A part wider than the column still breaks anywhere (the cell's
 * `overflow-wrap`), as before.
 */
function BreakableEmail({ email }: { email: string }) {
  const parts = email.split(/(?=[@.])/);
  return parts.map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts are static text.
    <span key={index}>
      {index > 0 && <wbr />}
      {part}
    </span>
  ));
}

/** aria-sort exposes the active order independently of the arrow icon. */
function SortableHeader({
  label,
  sortKey,
  active,
  direction,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  direction: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}) {
  const isActive = active === sortKey;
  return (
    <th
      className="px-2 py-3 xl:px-4 font-medium"
      aria-sort={isActive ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-[var(--text-primary)]"
      >
        {label}
        {isActive &&
          (direction === 'asc' ? (
            <ArrowUp className="size-3" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3" aria-hidden="true" />
          ))}
      </button>
    </th>
  );
}

export function UserTable({
  users,
  sort,
  direction,
  onSort,
  selection,
  onLimits,
}: {
  users: AdminUser[];
  sort: SortKey;
  direction: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
  selection: Pick<
    ReturnType<typeof useUserSelection>,
    'selected' | 'toggleSelected' | 'allOnPageSelected' | 'selectPage'
  >;
  onLimits: (user: AdminUser) => void;
}) {
  const { selected, toggleSelected, allOnPageSelected, selectPage } = selection;
  // Selection only feeds bulk changes, so read-only viewers get no checkboxes.
  const { canEdit } = useAdminAccess();
  return (
    <section
      // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
      tabIndex={0}
      aria-label="Accounts"
      className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
    >
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-[var(--border-subtle)] text-left text-xs uppercase tracking-wider text-[var(--text-muted)]">
            {canEdit && (
              <th className="w-10 px-2 py-3 xl:px-4">
                <input
                  type="checkbox"
                  aria-label="Select every account on this page"
                  checked={allOnPageSelected}
                  onChange={(event) => selectPage(event.target.checked)}
                />
              </th>
            )}
            <SortableHeader
              label="User"
              sortKey="name"
              active={sort}
              direction={direction}
              onSort={onSort}
            />
            <SortableHeader
              label="Role"
              sortKey="role"
              active={sort}
              direction={direction}
              onSort={onSort}
            />
            <SortableHeader
              label="Conversations"
              sortKey="threads"
              active={sort}
              direction={direction}
              onSort={onSort}
            />
            <SortableHeader
              label="Joined"
              sortKey="created"
              active={sort}
              direction={direction}
              onSort={onSort}
            />
            {canEdit && (
              <th className="px-2 py-3 xl:px-4">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-[var(--border-subtle)] last:border-0">
              {canEdit && (
                <td className="px-2 py-3 xl:px-4">
                  <input
                    type="checkbox"
                    aria-label={`Select ${user.email}`}
                    checked={selected.has(user.id)}
                    onChange={() => toggleSelected(user.id)}
                  />
                </td>
              )}
              {/* The one column that takes the width the others leave (#334):
                  the rest are as wide as their content, so an address is not
                  squeezed while Role keeps room it does not use. */}
              <td className="w-full px-2 py-3 xl:px-4">
                <Link
                  to="/admin/users/$userId"
                  params={{ userId: user.id }}
                  className="font-medium text-[var(--text-primary)] hover:underline"
                >
                  {user.name}
                </Link>
                {/* An address wraps anywhere rather than holding the table wider
                    than its area: since "Threads" became "Conversations" (#305)
                    the table needed 750 px and cut off Limits at 768 and
                    1024 px (#319, the range #57 fixed for the audit log). Cells
                    are a little narrower below 1280 px for the same reason. */}
                <p className="text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">
                  <BreakableEmail email={user.email} />
                </p>
              </td>
              <td className="px-2 py-3 xl:px-4">
                <div className="flex flex-wrap items-center gap-1">
                  {canEdit ? (
                    <UserRoleSelect user={user} />
                  ) : (
                    <Badge variant={ROLE_VARIANT[user.role]}>{ROLE_LABELS[user.role]}</Badge>
                  )}
                  {user.banned && <Badge variant="danger">Banned</Badge>}
                  {user.legalHold && (
                    <Badge variant="warning" title="Retention and deletion skip this person’s data">
                      Legal hold
                    </Badge>
                  )}
                </div>
              </td>
              {/* Short figures and dates stay on one line; the Role column,
                  mostly empty, is the one that gives way (#170). */}
              <td className="whitespace-nowrap px-2 py-3 xl:px-4 text-[var(--text-secondary)]">
                {user.threadCount}
              </td>
              <td className="whitespace-nowrap px-2 py-3 xl:px-4 text-[var(--text-muted)]">
                {formatRelativeTime(user.createdAt)}
              </td>
              {canEdit && (
                <td className="whitespace-nowrap px-2 py-3 xl:px-4 text-right">
                  {/* Named for its account, as Select and Role beside it are (#260). */}
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Limits for ${user.email}`}
                    onClick={() => onLimits(user)}
                  >
                    Limits
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
