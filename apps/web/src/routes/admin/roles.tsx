import type { RolesAccess, UserRole } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AdminPageHeader, LoadError, Notice } from '~/components/admin/admin-ui';
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import { Spinner } from '~/components/ui/spinner';
import { DEFAULT_ROLE_TAB, type RoleTab, validateRolesSearch } from '~/lib/admin-search';
import { api } from '~/lib/api-client';
import { InstanceWideSection } from './roles/instance-wide-section';
import { RolePanel } from './roles/role-panel';
import { ROLE_LABELS, ROLES_QUERY_KEY } from './roles/roles-helpers';

export { ROLES_QUERY_KEY } from './roles/roles-helpers';

const TABS = (Object.keys(ROLE_LABELS) as UserRole[]).map((id) => ({
  id,
  label: ROLE_LABELS[id],
})) satisfies readonly PillTab<RoleTab>[];

export function AdminRolesPage() {
  const navigate = useNavigate();
  const role = validateRolesSearch(useSearch({ strict: false })).role ?? DEFAULT_ROLE_TAB;
  const setRole = (next: RoleTab) =>
    void navigate({
      to: '/admin/roles',
      search: { role: next === DEFAULT_ROLE_TAB ? undefined : next },
      replace: true,
    });

  const roles = useQuery({
    queryKey: ROLES_QUERY_KEY,
    queryFn: () => api.get<RolesAccess>('/admin/roles'),
  });
  const access = roles.data?.roles.find((entry) => entry.role === role);

  return (
    <div>
      <AdminPageHeader
        title="Roles & access"
        description="Everything that shapes what one role can do — limits, storage, budgets, models and features — in one place."
      />

      <div className="flex flex-col gap-8 pb-10">
        <PillTabs
          tabs={TABS}
          active={role}
          onChange={setRole}
          label="Roles"
          controls="role-panel"
        />

        <div id="role-panel" role="tabpanel" aria-label={`${ROLE_LABELS[role]} role`}>
          {access ? (
            // Keyed by role so a half-edited draft never carries over to another role.
            <RolePanel key={role} access={access} />
          ) : roles.isError ? (
            <LoadError title="Role access could not be loaded." query={roles} />
          ) : roles.data ? (
            <p className="text-[var(--text-muted)] text-sm">Nothing is recorded for this role.</p>
          ) : (
            <div role="status" aria-label="Loading role access">
              <Spinner className="mx-auto size-5" />
            </div>
          )}
        </div>

        <InstanceWideSection />

        <Notice title="Limits are shared across replicas through Redis">
          Without Redis these fall back to per-process counting, which means the effective limit is
          multiplied by the number of API replicas.
        </Notice>
      </div>
    </div>
  );
}
