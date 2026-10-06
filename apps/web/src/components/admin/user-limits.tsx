import {
  type AdminModel,
  type AdminUser,
  MICROS_PER_DOLLAR,
  type QuotaMetric,
  type StorageUsage,
  type UsageAllowance,
  type UsageSummary,
} from '@oci/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { LoadError } from '~/components/admin/admin-ui';
import { ProgressBar, type ProgressTone } from '~/components/admin/progress-bar';
import { QuotaOverrideDialog } from '~/components/admin/quota-override-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatBytes, formatDateTime, formatTimeUntil, plural } from '~/lib/utils';

export interface UserLimits {
  usage: UsageSummary;
  storage: StorageUsage;
}

export function userLimitsQueryKey(userId: string) {
  return ['admin', 'users', userId, 'limits'] as const;
}

export function formatQuotaAmount(value: number, metric: QuotaMetric): string {
  if (metric === 'cost') return `$${(value / MICROS_PER_DOLLAR).toFixed(2)}`;
  const count = value.toLocaleString('en-US');
  if (metric === 'tokens') return `${count} token${value === 1 ? '' : 's'}`;
  return `${count} message${value === 1 ? '' : 's'}`;
}

function windowLabel(allowance: UsageAllowance): string {
  switch (allowance.windowKind) {
    case 'rolling':
      return `Rolling ${plural(allowance.windowHours ?? 24, 'hour')}`;
    case 'daily':
      return 'Daily';
    case 'weekly':
      return 'Weekly';
    case 'monthly':
      return 'Monthly';
    default:
      return '';
  }
}

/** Severity comes from the server, matching the warnings the user sees. */
const SEVERITY: Record<
  UsageAllowance['severity'],
  { label: string; variant: 'neutral' | 'warning' | 'danger'; tone: ProgressTone }
> = {
  ok: { label: 'Within limit', variant: 'neutral', tone: 'neutral' },
  warning: { label: 'Approaching limit', variant: 'warning', tone: 'warning' },
  critical: { label: 'Nearly used up', variant: 'danger', tone: 'danger' },
  exceeded: { label: 'Limit reached', variant: 'danger', tone: 'danger' },
};

function resetText(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const until = formatTimeUntil(resetsAt);
  return until === 'expired' ? 'Resetting now' : `Resets ${until}`;
}

/**
 * The models a budget applies to, by the names the rest of the admin shows
 * ("E2E catalog beta"), not their internal slugs (#285). A slug no longer in
 * the catalog, or while the catalog loads, is shown as it is.
 */
export function budgetModelNames(
  slugs: readonly string[],
  models: readonly Pick<AdminModel, 'slug' | 'displayName'>[] | undefined,
): string {
  const names = new Map(models?.map((model) => [model.slug, model.displayName]));
  return slugs.map((slug) => names.get(slug) ?? slug).join(', ');
}

function BudgetRow({
  allowance,
  models,
}: {
  allowance: UsageAllowance;
  models: AdminModel[] | undefined;
}) {
  const severity = SEVERITY[allowance.severity];
  const used = formatQuotaAmount(allowance.used, allowance.metric);
  const limit = formatQuotaAmount(allowance.limitValue, allowance.metric);
  const reset = resetText(allowance.resetsAt);

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 font-medium text-sm">
          {allowance.name}{' '}
          <span className="font-normal text-[var(--text-muted)]">· {windowLabel(allowance)}</span>
        </p>
        <Badge variant={severity.variant}>{severity.label}</Badge>
      </div>
      <p className="mt-1 text-[var(--text-secondary)] text-sm">
        {used} of {limit} used
      </p>
      <ProgressBar
        className="mt-2"
        value={allowance.used}
        max={allowance.limitValue}
        label={`${allowance.name} used`}
        valueText={`${used} of ${limit}`}
        tone={severity.tone}
      />
      <p className="mt-1.5 flex flex-wrap gap-x-2 text-[var(--text-muted)] text-xs">
        <span>{formatQuotaAmount(allowance.remaining, allowance.metric)} remaining</span>
        {reset && allowance.resetsAt && (
          <time dateTime={allowance.resetsAt} title={formatDateTime(allowance.resetsAt)}>
            · {reset}
          </time>
        )}
        {allowance.modelSlugs.length > 0 && (
          <span>· Applies to {budgetModelNames(allowance.modelSlugs, models)}</span>
        )}
      </p>
    </li>
  );
}

function RecentUsage({ recent }: { recent: UsageSummary['recent'] }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border-subtle)] p-4">
      <p className="text-[var(--text-secondary)] text-sm">No budgets apply to this role.</p>
      <p className="mt-1 text-[var(--text-muted)] text-xs">Usage in the last 24 hours:</p>
      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-[var(--text-muted)] text-xs">Messages</dt>
          <dd className="font-medium">{recent.messages.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)] text-xs">Tokens</dt>
          <dd className="font-medium">{recent.tokens.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)] text-xs">Cost</dt>
          <dd className="font-medium">{formatQuotaAmount(recent.costMicros, 'cost')}</dd>
        </div>
      </dl>
    </div>
  );
}

function storageTone(used: number, limit: number): ProgressTone {
  const fraction = used / limit;
  if (fraction >= 1) return 'danger';
  return fraction >= 0.8 ? 'warning' : 'neutral';
}

function StorageRow({
  label,
  used,
  limit,
  format,
}: {
  label: string;
  used: number;
  limit: number | null;
  format: (value: number) => string;
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-[var(--text-secondary)]">
          {limit === null ? `${format(used)} · Unlimited` : `${format(used)} of ${format(limit)}`}
        </span>
      </div>
      {limit !== null && (
        <ProgressBar
          className="mt-2"
          value={used}
          max={limit}
          label={`${label} used`}
          valueText={`${format(used)} of ${format(limit)}`}
          tone={storageTone(used, limit)}
        />
      )}
    </li>
  );
}

function StorageLimits({ storage }: { storage: StorageUsage }) {
  const files = (value: number) => `${value.toLocaleString('en-US')} file${value === 1 ? '' : 's'}`;
  return (
    <>
      <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
        <StorageRow
          label="Storage"
          used={storage.liveBytes}
          limit={storage.maxTotalBytes}
          format={formatBytes}
        />
        <StorageRow
          label="Files"
          used={storage.liveFileCount}
          limit={storage.maxFileCount}
          format={files}
        />
        <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
          <span className="font-medium">Largest upload</span>
          <span className="text-[var(--text-secondary)]">
            {storage.maxFileBytes === null ? 'Unlimited' : formatBytes(storage.maxFileBytes)}
          </span>
        </li>
      </ul>
      {storage.pendingFileCount > 0 && (
        <p className="mt-2 text-[var(--text-muted)] text-xs">
          A further {formatBytes(storage.pendingBytes)} in {files(storage.pendingFileCount)} is in
          the trash and does not count toward the limit.
        </p>
      )}
    </>
  );
}

/**
 * What one account is held to right now: each budget with its current use and
 * reset time, and storage against the role's allowance. Computed by the same
 * functions that enforce the limits.
 */
export function UserLimitsSection({ user }: { user: AdminUser }) {
  const queryClient = useQueryClient();
  const headingId = useId();
  const [adjusting, setAdjusting] = useState(false);
  const limits = useQuery({
    queryKey: userLimitsQueryKey(user.id),
    queryFn: () => api.get<UserLimits>(`/admin/users/${user.id}/limits`),
  });

  // The catalog, for the names of the models a budget is limited to; shared
  // with the budget dialog's picker, and only asked for when one is (#285).
  const scoped = limits.data?.usage.allowances.some((entry) => entry.modelSlugs.length > 0);
  const models = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api.get<{ models: AdminModel[] }>('/admin/models'),
    enabled: Boolean(scoped),
  });

  function closeAdjust() {
    setAdjusting(false);
    // Overrides change the budgets shown here.
    void queryClient.invalidateQueries({ queryKey: userLimitsQueryKey(user.id) });
  }

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="font-semibold text-base">
          Limits
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/admin/roles"
            search={{ role: user.role }}
            className="text-[var(--accent-bright)] text-sm hover:underline"
          >
            Role settings
          </Link>
          <EditOnly>
            <Button type="button" size="sm" variant="secondary" onClick={() => setAdjusting(true)}>
              Adjust limits
            </Button>
          </EditOnly>
        </div>
      </div>

      <div className="mt-3">
        {limits.isLoading ? (
          <div role="status" aria-label="Loading limits" className="flex justify-center py-6">
            <Spinner className="size-5" />
          </div>
        ) : !limits.data ? (
          <LoadError title="Limits could not be loaded." query={limits} className="p-6" />
        ) : (
          <div className="flex flex-col gap-6">
            <div>
              <h3 className="mb-2 font-medium text-[var(--text-muted)] text-xs uppercase tracking-wider">
                Budgets
              </h3>
              {limits.data.usage.allowances.length === 0 ? (
                <RecentUsage recent={limits.data.usage.recent} />
              ) : (
                <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
                  {limits.data.usage.allowances.map((allowance) => (
                    <BudgetRow
                      key={allowance.policyId}
                      allowance={allowance}
                      models={models.data?.models}
                    />
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 font-medium text-[var(--text-muted)] text-xs uppercase tracking-wider">
                Storage
              </h3>
              <StorageLimits storage={limits.data.storage} />
            </div>
          </div>
        )}
      </div>

      <Dialog open={adjusting} onOpenChange={(open) => !open && closeAdjust()}>
        {adjusting && <QuotaOverrideDialog user={user} onClose={closeAdjust} />}
      </Dialog>
    </section>
  );
}
