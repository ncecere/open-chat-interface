import type { GroupRef } from '@oci/shared';
import { Link } from '@tanstack/react-router';
import { cn } from '~/lib/utils';

/**
 * Groups as read-only chips (v0.14): each links to the group's own page, which
 * is where what a group grants is changed. A list that names itself, so a
 * screen reader hears what the chips are; nothing renders for no groups.
 */
export function GroupChips({
  groups,
  label,
  className,
}: {
  groups: readonly GroupRef[] | undefined;
  /** What the groups are, for the list's accessible name: "Groups with this budget". */
  label: string;
  className?: string;
}) {
  if (!groups || groups.length === 0) return null;
  return (
    <ul aria-label={label} className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {groups.map((group) => (
        <li key={group.id} className="min-w-0">
          <Link
            to="/admin/groups/$groupId"
            params={{ groupId: group.id }}
            title={group.name}
            className="inline-flex max-w-48 items-center truncate rounded-full border border-[var(--border-strong)] px-2 py-0.5 font-semibold text-[0.6875rem] text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]"
          >
            {group.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}
