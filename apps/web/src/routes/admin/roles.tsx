import {
  MICROS_PER_DOLLAR,
  type RateLimitSettings,
  type ReserveAmounts,
  type RoleAccess,
  type RolesAccess,
  type StoragePolicy,
  type UserRole,
} from '@oci/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  LoadError,
  MutationError,
  Notice,
  SettingsSection,
} from '~/components/admin/admin-ui';
import {
  CONFIG_SOURCES_QUERY_KEY,
  ConfigSourceBadge,
  useConfigSources,
} from '~/components/admin/config-source';
import { RoleFeaturesForm } from '~/components/admin/role-features-form';
import { RoleToolsForm } from '~/components/admin/role-tools-form';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { DEFAULT_ROLE_TAB, type RoleTab, validateRolesSearch } from '~/lib/admin-search';
import { api } from '~/lib/api-client';
import { GB, MB, toNullableNumber } from '~/routes/admin/lifecycle-shared';

export const ROLES_QUERY_KEY = ['admin', 'roles'] as const;

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  auditor: 'Auditor',
  user: 'User',
  restricted: 'Restricted',
};

const TABS = (Object.keys(ROLE_LABELS) as UserRole[]).map((id) => ({
  id,
  label: ROLE_LABELS[id],
})) satisfies readonly PillTab<RoleTab>[];

const RATE_FIELDS: Array<{ key: keyof RateLimitSettings; label: string; max: number }> = [
  { key: 'maxConcurrentStreams', label: 'Concurrent responses', max: 100 },
  { key: 'chatRequestsPerMinute', label: 'Messages per minute', max: 10_000 },
  { key: 'uploadRequestsPerMinute', label: 'Uploads per minute', max: 10_000 },
];

const RATE_FIELD_IDS: Record<keyof RateLimitSettings, string> = {
  maxConcurrentStreams: 'concurrent',
  chatRequestsPerMinute: 'chat',
  uploadRequestsPerMinute: 'upload',
};

interface RateLimitConfig {
  roles: Record<UserRole, RateLimitSettings>;
  authAttemptsPerMinute: number;
  reserve: ReserveAmounts;
}

function isWholeNumberIn(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

/** Everything this page summarises can change after any write it makes. */
function invalidateAccess(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ROLES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'rate-limits'] }),
    queryClient.invalidateQueries({ queryKey: ['admin', 'storage-policies'] }),
    queryClient.invalidateQueries({ queryKey: CONFIG_SOURCES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY }),
    // A role's features and reasoning levels shape the composer, including
    // the administrator's own.
    queryClient.invalidateQueries({ queryKey: ['me'] }),
    queryClient.invalidateQueries({ queryKey: ['models', 'catalog'] }),
  ]);
}

function SavedNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="flex items-center gap-1.5 text-[var(--success)] text-sm">
      <CheckCircle2 className="size-4" aria-hidden="true" />
      Saved
    </span>
  );
}

function useSavedFlash() {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2_500);
    return () => clearTimeout(timer);
  }, [saved]);
  return [saved, setSaved] as const;
}

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

function RateLimitForm({ access }: { access: RoleAccess }) {
  const queryClient = useQueryClient();
  const { role, rateLimits, rateLimitSources } = access;
  const [draft, setDraft] = useState<Record<keyof RateLimitSettings, string>>(() =>
    draftFromLimits(rateLimits),
  );
  const [saved, setSaved] = useSavedFlash();

  useEffect(() => setDraft(draftFromLimits(rateLimits)), [rateLimits]);

  // Only fields that differ from the stored value are sent, so saving one role
  // never pins another role's (or another field's) inherited value.
  const changes: Partial<RateLimitSettings> = {};
  for (const { key } of RATE_FIELDS) {
    const value = Number(draft[key]);
    if (draft[key].trim() !== '' && value !== rateLimits[key]) changes[key] = value;
  }
  const invalid = RATE_FIELDS.filter(
    ({ key, max }) => !isWholeNumberIn(Number(draft[key]), max) || draft[key].trim() === '',
  );
  const hasChanges = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: () => api.put('/admin/lifecycle/rate-limits', { roles: { [role]: changes } }),
    onSuccess: async () => {
      setSaved(true);
      await invalidateAccess(queryClient);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (hasChanges && invalid.length === 0) save.mutate();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-3">
        {RATE_FIELDS.map(({ key, label, max }) => {
          const id = `rate-${role}-${RATE_FIELD_IDS[key]}`;
          const fieldInvalid = invalid.some((field) => field.key === key);
          return (
            <Field key={key} label={label} htmlFor={id}>
              <Input
                id={id}
                type="number"
                min="1"
                max={max}
                step="1"
                value={draft[key]}
                aria-invalid={fieldInvalid}
                aria-describedby={`${id}-source`}
                onChange={(event) => {
                  save.reset();
                  setSaved(false);
                  setDraft((current) => ({ ...current, [key]: event.target.value }));
                }}
              />
              <ConfigSourceBadge id={`${id}-source`} source={rateLimitSources[key]} />
            </Field>
          );
        })}
      </div>
      {invalid.length > 0 && (
        <p role="alert" className="text-[var(--danger)] text-sm">
          Enter a whole number of 1 or more for{' '}
          {invalid.map((field) => field.label.toLowerCase()).join(', ')}.
        </p>
      )}

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message={`Rate limits for the ${role} role could not be saved.`}
            className="mr-auto"
          />
          <SavedNote show={saved} />
          <Button
            type="submit"
            variant="primary"
            disabled={!hasChanges || invalid.length > 0 || save.isPending}
          >
            {save.isPending && <Spinner />}
            Save rate limits
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

function draftFromLimits(limits: RateLimitSettings): Record<keyof RateLimitSettings, string> {
  return {
    maxConcurrentStreams: String(limits.maxConcurrentStreams),
    chatRequestsPerMinute: String(limits.chatRequestsPerMinute),
    uploadRequestsPerMinute: String(limits.uploadRequestsPerMinute),
  };
}

interface StoragePolicyDraft {
  maxTotalGb: string;
  maxFileCount: string;
  maxFileMb: string;
  enabled: boolean;
}

function draftFromPolicy(policy: StoragePolicy | null): StoragePolicyDraft {
  return {
    maxTotalGb: policy?.maxTotalBytes ? String(policy.maxTotalBytes / GB) : '',
    maxFileCount: policy?.maxFileCount ? String(policy.maxFileCount) : '',
    maxFileMb: policy?.maxFileBytes ? String(policy.maxFileBytes / MB) : '',
    enabled: policy?.enabled ?? true,
  };
}

function StorageAllowanceForm({ access }: { access: RoleAccess }) {
  const queryClient = useQueryClient();
  const { role, storage } = access;
  const [draft, setDraft] = useState(() => draftFromPolicy(storage));
  const [saved, setSaved] = useSavedFlash();

  useEffect(() => setDraft(draftFromPolicy(storage)), [storage]);

  const save = useMutation({
    mutationFn: () => {
      const totalGb = toNullableNumber(draft.maxTotalGb);
      const fileMb = toNullableNumber(draft.maxFileMb);
      // The endpoint replaces the whole record, so every field is sent.
      return api.put(`/admin/lifecycle/storage-policies/${role}`, {
        role,
        maxTotalBytes: totalGb === null ? null : Math.round(totalGb * GB),
        maxFileCount: toNullableNumber(draft.maxFileCount),
        maxFileBytes: fileMb === null ? null : Math.round(fileMb * MB),
        enabled: draft.enabled,
      });
    },
    onSuccess: async () => {
      setSaved(true);
      await invalidateAccess(queryClient);
    },
  });

  function update(patch: Partial<StoragePolicyDraft>) {
    save.reset();
    setSaved(false);
    setDraft((current) => ({ ...current, ...patch }));
  }

  return (
    <form
      className="flex flex-col gap-4"
      // Blank means unlimited and fractional gigabytes are fine, so the
      // browser's step checks would only get in the way.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor={`storage-${role}-enabled`} className="font-medium text-sm">
            Enforce allowance
          </label>
          <p className="text-[var(--text-muted)] text-xs">
            {storage === null
              ? 'No allowance is saved for this role, so storage is unlimited.'
              : 'When off, people in this role can store without limit.'}
          </p>
        </div>
        <Switch
          id={`storage-${role}-enabled`}
          checked={draft.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Total storage (GB)" htmlFor={`storage-${role}-total`}>
          <Input
            id={`storage-${role}-total`}
            type="number"
            min="0.1"
            step="0.1"
            placeholder="Unlimited"
            value={draft.maxTotalGb}
            onChange={(event) => update({ maxTotalGb: event.target.value })}
          />
        </Field>
        <Field label="Stored files" htmlFor={`storage-${role}-count`}>
          <Input
            id={`storage-${role}-count`}
            type="number"
            min="1"
            step="1"
            placeholder="Unlimited"
            value={draft.maxFileCount}
            onChange={(event) => update({ maxFileCount: event.target.value })}
          />
        </Field>
        <Field label="Per file (MB)" htmlFor={`storage-${role}-file`}>
          <Input
            id={`storage-${role}-file`}
            type="number"
            min="1"
            step="1"
            placeholder="Instance default"
            value={draft.maxFileMb}
            onChange={(event) => update({ maxFileMb: event.target.value })}
          />
        </Field>
      </div>

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message={`The ${role} storage allowance could not be saved.`}
            className="mr-auto"
          />
          <SavedNote show={saved} />
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            Save allowance
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

function formatBudgetLimit(budget: RoleAccess['budgets'][number]): string {
  if (budget.metric !== 'cost') {
    return `${budget.limitValue.toLocaleString()} ${budget.metric}`;
  }
  const dollars = budget.limitValue / MICROS_PER_DOLLAR;
  return `$${dollars.toFixed(dollars > 0 && dollars < 0.01 ? 4 : 2)}`;
}

function formatBudgetWindow(budget: RoleAccess['budgets'][number]): string {
  return budget.windowKind === 'rolling'
    ? `Rolling ${budget.windowHours ?? 24} hours`
    : budget.windowKind.charAt(0).toUpperCase() + budget.windowKind.slice(1);
}

const METRIC_LABELS: Record<RoleAccess['budgets'][number]['metric'], string> = {
  messages: 'Messages',
  tokens: 'Tokens',
  cost: 'Cost',
};

function BudgetList({ access }: { access: RoleAccess }) {
  return (
    <div className="flex flex-col gap-3">
      {access.budgets.length === 0 ? (
        <p className="text-[var(--text-muted)] text-sm">
          No usage budget applies to this role, so usage is limited only by the rate limits above.
        </p>
      ) : (
        <div className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]">
          <table className="w-full min-w-[32rem] text-sm">
            <thead className="bg-[var(--bg-control-alt)] text-left text-[var(--text-muted)] text-xs">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Metric
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Limit
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Window
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {access.budgets.map((budget) => (
                <tr key={budget.id} className="border-[var(--border-subtle)] border-t">
                  <td className="px-4 py-2 font-medium">{budget.name}</td>
                  <td className="px-4 py-2">{METRIC_LABELS[budget.metric]}</td>
                  <td className="px-4 py-2">{formatBudgetLimit(budget)}</td>
                  <td className="px-4 py-2">{formatBudgetWindow(budget)}</td>
                  <td className="px-4 py-2 text-[var(--text-muted)]">
                    {budget.enabled ? 'Enabled' : 'Disabled'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Link to="/admin/quotas" className="text-[var(--accent-bright)] text-sm hover:underline">
        Manage usage budgets
      </Link>
    </div>
  );
}

function InstanceWideForm({ settings }: { settings: RateLimitConfig }) {
  const queryClient = useQueryClient();
  const sources = useConfigSources().data?.rateLimits;
  const [auth, setAuth] = useState(String(settings.authAttemptsPerMinute));
  const [costDollars, setCostDollars] = useState(
    (settings.reserve.costMicros / MICROS_PER_DOLLAR).toFixed(2),
  );
  const [tokens, setTokens] = useState(String(settings.reserve.tokens));
  const [saved, setSaved] = useSavedFlash();

  useEffect(() => {
    setAuth(String(settings.authAttemptsPerMinute));
    setCostDollars((settings.reserve.costMicros / MICROS_PER_DOLLAR).toFixed(2));
    setTokens(String(settings.reserve.tokens));
  }, [settings]);

  // Dollars become integer micro-dollars so no amount is stored as a float.
  const costMicros = Math.round(Number(costDollars || 0) * MICROS_PER_DOLLAR);
  const valid =
    isWholeNumberIn(Number(auth), 1_000) &&
    isWholeNumberIn(costMicros, 100_000_000) &&
    isWholeNumberIn(Number(tokens), 10_000_000);

  const patch: {
    authAttemptsPerMinute?: number;
    reserve?: Partial<ReserveAmounts>;
  } = {};
  if (Number(auth) !== settings.authAttemptsPerMinute) patch.authAttemptsPerMinute = Number(auth);
  const reserve: Partial<ReserveAmounts> = {};
  if (costMicros !== settings.reserve.costMicros) reserve.costMicros = costMicros;
  if (Number(tokens) !== settings.reserve.tokens) reserve.tokens = Number(tokens);
  if (Object.keys(reserve).length > 0) patch.reserve = reserve;
  const hasChanges = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: () => api.put('/admin/lifecycle/rate-limits', patch),
    onSuccess: async () => {
      setSaved(true);
      await invalidateAccess(queryClient);
    },
  });

  function edit(setter: (value: string) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      save.reset();
      setSaved(false);
      setter(event.target.value);
    };
  }

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges && valid) save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Sign-in attempts per minute"
          htmlFor="rate-auth"
          hint="Failed sign-ins per account. An address has its own, larger allowance."
        >
          <Input
            id="rate-auth"
            type="number"
            min="1"
            step="1"
            value={auth}
            aria-describedby={sources ? 'rate-auth-source' : undefined}
            onChange={edit(setAuth)}
          />
          <ConfigSourceBadge id="rate-auth-source" source={sources?.authAttemptsPerMinute} />
        </Field>
        <Field
          label="Budget held per response"
          htmlFor="reserve-cost"
          hint="In US dollars, released when the response finishes."
        >
          <Input
            id="reserve-cost"
            type="number"
            min="0.01"
            step="0.01"
            value={costDollars}
            aria-describedby={sources ? 'reserve-cost-source' : undefined}
            onChange={edit(setCostDollars)}
          />
          <ConfigSourceBadge id="reserve-cost-source" source={sources?.reserve.costMicros} />
        </Field>
        <Field
          label="Tokens held per response"
          htmlFor="reserve-tokens"
          hint="Used by token budgets in the same way."
        >
          <Input
            id="reserve-tokens"
            type="number"
            min="1"
            step="100"
            value={tokens}
            aria-describedby={sources ? 'reserve-tokens-source' : undefined}
            onChange={edit(setTokens)}
          />
          <ConfigSourceBadge id="reserve-tokens-source" source={sources?.reserve.tokens} />
        </Field>
      </div>

      <p className="text-[var(--text-muted)] text-xs">
        A reservation is held while a response generates, then replaced by what was actually used,
        so simultaneous responses cannot collectively pass a budget. It is never charged.
      </p>

      {!valid && (
        <p role="alert" className="text-[var(--danger)] text-sm">
          Enter positive amounts for every instance-wide limit.
        </p>
      )}

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message="Instance-wide limits could not be saved."
            className="mr-auto"
          />
          <SavedNote show={saved} />
          <Button
            type="submit"
            variant="primary"
            disabled={!hasChanges || !valid || save.isPending}
          >
            {save.isPending && <Spinner />}
            Save instance-wide limits
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

function InstanceWideSection() {
  const rateLimits = useQuery({
    queryKey: ['admin', 'rate-limits'],
    queryFn: () => api.get<RateLimitConfig>('/admin/lifecycle/rate-limits'),
  });

  return (
    <SettingsSection
      title="Instance-wide"
      description="Limits that apply to everyone regardless of role: sign-in attempts, and the amount reserved while a response generates."
    >
      {rateLimits.data ? (
        <InstanceWideForm settings={rateLimits.data} />
      ) : rateLimits.isError ? (
        <LoadError title="Instance-wide limits could not be loaded." query={rateLimits} />
      ) : (
        <div role="status" aria-label="Loading instance-wide limits">
          <Spinner className="mx-auto size-5" />
        </div>
      )}
    </SettingsSection>
  );
}

function RolePanel({ access }: { access: RoleAccess }) {
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
