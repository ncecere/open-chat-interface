import type { RolesAccessGroup } from '@oci/shared';
import { Link } from '@tanstack/react-router';
import { plural } from '~/lib/utils';

function Names({
  label,
  items,
  disabledNote,
}: {
  label: string;
  items: ReadonlyArray<{ id: string; name: string; enabled: boolean }>;
  disabledNote: string;
}) {
  return (
    <div>
      <dt className="text-[var(--text-muted)] text-xs">{label}</dt>
      <dd className="mt-0.5">
        {items.length === 0 ? (
          <span className="text-[var(--text-muted)]">None</span>
        ) : (
          items.map((item, index) => (
            <span key={item.id}>
              {index > 0 && ', '}
              <span className={item.enabled ? undefined : 'text-[var(--text-muted)]'}>
                {item.name}
                {!item.enabled && ` (${disabledNote})`}
              </span>
            </span>
          ))
        )}
      </dd>
    </div>
  );
}

/**
 * What each group adds on top of a role, read-only (v0.14). Not per role: a
 * group's people have any role. Changed on the group's own page.
 */
export function GroupsSection({ groups }: { groups: readonly RolesAccessGroup[] }) {
  return (
    <section aria-labelledby="role-groups-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="role-groups-heading" className="font-semibold text-base">
          Groups
        </h2>
        <p className="mt-1 max-w-2xl text-[var(--text-muted)] text-sm">
          Groups add to a role; they never take access away. A person gets what their role gives,
          plus the budgets and models of each group they are in.{' '}
          <Link to="/admin/groups" className="text-[var(--accent-bright)] hover:underline">
            Manage groups
          </Link>
        </p>
      </div>

      {groups.length === 0 ? (
        <p className="text-[var(--text-muted)] text-sm">No groups yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          {groups.map((group) => (
            <li key={group.id} className="flex flex-col gap-3 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <Link
                  to="/admin/groups/$groupId"
                  params={{ groupId: group.id }}
                  className="font-medium text-sm hover:underline"
                >
                  {group.name}
                </Link>
                <span className="text-[var(--text-muted)] text-xs">
                  {plural(group.memberCount, 'member')}, {plural(group.managerCount, 'manager')}
                </span>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <Names label="Budgets" items={group.budgets} disabledNote="not enforced" />
                <Names
                  label="Extra models"
                  items={group.models.map((model) => ({
                    id: model.id,
                    name: model.displayName,
                    enabled: model.enabled,
                  }))}
                  disabledNote="disabled"
                />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
