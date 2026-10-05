import type { RoleAccess } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { SettingsSection } from '~/components/admin/admin-ui';
import { RoleFeaturesForm } from '~/components/admin/role-features-form';
import { RoleToolsForm } from '~/components/admin/role-tools-form';
import { BudgetList } from './budget-list';
import { RateLimitForm } from './rate-limit-form';
import { invalidateAccess, ROLE_LABELS } from './roles-helpers';
import { StorageAllowanceForm } from './storage-allowance-form';

function RoleSummary({ access }: { access: RoleAccess }) {
  const label = ROLE_LABELS[access.role].toLowerCase();
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-[var(--text-muted)] text-xs">People with this role</dt>
          <dd className="mt-1 font-semibold text-lg">
            <Link
              to="/admin/users"
              search={{ role: access.role }}
              className="underline-offset-4 hover:underline"
            >
              {access.userCount.toLocaleString()}
              <span className="sr-only"> — view {label} accounts</span>
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)] text-xs">Models</dt>
          <dd className="mt-1 font-semibold text-lg">
            {access.models.visible} of {access.models.available} visible
          </dd>
          {/* Inside a dd: a dl group may contain only dt and dd elements. */}
          <dd>
            <Link
              to="/admin/models"
              search={{ tab: 'models' }}
              className="text-[var(--accent-bright)] text-xs hover:underline"
            >
              Choose which roles see each model
            </Link>
          </dd>
        </div>
      </dl>

      {access.fixedRules.length > 0 && (
        <div>
          <h3 className="font-medium text-sm">Fixed rules</h3>
          <p className="mt-1 text-[var(--text-muted)] text-xs">
            Always true for this role; no setting changes them.
          </p>
          <ul className="mt-3 list-disc pl-5 text-sm">
            {access.fixedRules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function RolePanel({ access }: { access: RoleAccess }) {
  const queryClient = useQueryClient();
  const label = ROLE_LABELS[access.role].toLowerCase();
  return (
    <div className="flex flex-col gap-10">
      <SettingsSection
        editable={false}
        title="Summary"
        description={`What someone with the ${label} role can do today.`}
      >
        <RoleSummary access={access} />
      </SettingsSection>

      <SettingsSection
        title="Features"
        description={`What people with the ${label} role may use, and which reasoning levels they may choose.`}
      >
        <RoleFeaturesForm
          access={access}
          roleLabel={label}
          onSaved={() => invalidateAccess(queryClient)}
        />
      </SettingsSection>

      <SettingsSection
        title="Tools"
        description={`Which tools the ${label} role’s models may call during a reply. Write tools always ask for approval.`}
      >
        <RoleToolsForm
          access={access}
          roleLabel={label}
          onSaved={() => invalidateAccess(queryClient)}
        />
      </SettingsSection>

      <SettingsSection
        title="Rate limits"
        description="How many responses one person may generate at once, and how fast requests may arrive."
      >
        <RateLimitForm access={access} />
      </SettingsSection>

      <SettingsSection
        title="Storage allowance"
        description="How much each person in this role may store. Leave a field blank for no limit."
      >
        <StorageAllowanceForm access={access} />
      </SettingsSection>

      <SettingsSection
        editable={false}
        title="Usage budgets"
        description="Budgets assigned to this role. Each person gets the full amount on their own."
      >
        <BudgetList access={access} />
      </SettingsSection>
    </div>
  );
}
