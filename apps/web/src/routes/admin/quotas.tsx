import { MICROS_PER_DOLLAR, type QuotaMetric, type QuotaPolicy } from '@oci/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { AdminPageHeader, EmptyState, LoadError, Row, RowList } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { QuotaPolicyDialog } from '~/components/admin/quota-policy-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Dialog } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';

function formatLimit(policy: QuotaPolicy): string {
  const labels: Record<QuotaMetric, string> = {
    messages: 'messages',
    tokens: 'tokens',
    cost: '',
  };

  if (policy.metric !== 'cost') {
    return `${policy.limitValue.toLocaleString()} ${labels[policy.metric]}`;
  }

  const dollars = policy.limitValue / MICROS_PER_DOLLAR;
  // Sub-cent limits would otherwise all render as "$0.00".
  return `$${dollars.toFixed(dollars > 0 && dollars < 0.01 ? 4 : 2)}`;
}

function formatWindow(policy: QuotaPolicy): string {
  switch (policy.windowKind) {
    case 'rolling':
      return `rolling ${policy.windowHours ?? 24}h`;
    case 'daily':
      return `daily · ${policy.timezone}`;
    case 'weekly':
      return `weekly · ${policy.timezone}`;
    case 'monthly':
      return `monthly · ${policy.timezone}`;
    default:
      return '';
  }
}

export function AdminQuotasPage() {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<{ policy: QuotaPolicy | null } | null>(null);
  const [deleteFor, setDeleteFor] = useState<QuotaPolicy | null>(null);

  const quotas = useQuery({
    queryKey: ['admin', 'quotas'],
    queryFn: () => api.get<{ policies: QuotaPolicy[] }>('/admin/quotas'),
  });
  const { data, isLoading } = quotas;

  async function deletePolicy(policy: QuotaPolicy) {
    await api.delete(`/admin/quotas/${policy.id}`);
    await queryClient.invalidateQueries({ queryKey: ['admin', 'quotas'] });
  }

  const policies = data?.policies ?? [];

  return (
    <div>
      <AdminPageHeader
        title="Usage budgets"
        description="Create a policy, then apply it to the roles that should share it. A role can carry several policies at once, and every one of them is enforced. Scope a policy to specific models to give a family such as Anthropic its own budget."
        actions={
          <EditOnly>
            <Button variant="primary" onClick={() => setFormFor({ policy: null })}>
              <Plus />
              New policy
            </Button>
          </EditOnly>
        }
      />

      {isLoading ? (
        <div className="py-16">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : quotas.isError || !data ? (
        <LoadError title="Quota policies could not be loaded." query={quotas} />
      ) : policies.length > 0 ? (
        <RowList>
          {policies.map((policy) => (
            <Row key={policy.id}>
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-control-hover)]">
                <Gauge className="size-4 text-[var(--text-secondary)]" />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate font-medium" title={policy.name}>
                    {policy.name}
                  </p>
                  <Badge variant="neutral">{formatLimit(policy)}</Badge>
                  {!policy.enabled && <Badge variant="warning">not enforced</Badge>}
                  {policy.roles.length === 0 && <Badge variant="warning">no roles</Badge>}
                  <Badge variant="neutral">
                    {policy.modelSlugs.length === 0
                      ? 'all models'
                      : `${policy.modelSlugs.length} model${policy.modelSlugs.length === 1 ? '' : 's'}`}
                  </Badge>
                  {/* Keeps an override discoverable from the policy as well as
                      from the person it was granted to. */}
                  {policy.overrideCount > 0 && (
                    <Badge variant="outline">
                      {policy.overrideCount} override{policy.overrideCount === 1 ? '' : 's'}
                    </Badge>
                  )}
                </div>
                <p
                  className="truncate text-xs text-[var(--text-muted)]"
                  title={`${formatWindow(policy)}${policy.roles.length > 0 ? ` · ${policy.roles.join(', ')}` : ''}${policy.description ? ` · ${policy.description}` : ''}`}
                >
                  {formatWindow(policy)}
                  {policy.roles.length > 0 ? ` · ${policy.roles.join(', ')}` : ''}
                  {policy.description ? ` · ${policy.description}` : ''}
                </p>
              </div>

              <EditOnly>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${policy.name}`}
                  onClick={() => setFormFor({ policy })}
                >
                  <Pencil />
                </Button>

                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${policy.name}`}
                  onClick={() => setDeleteFor(policy)}
                >
                  <Trash2 />
                </Button>
              </EditOnly>
            </Row>
          ))}
        </RowList>
      ) : (
        <EmptyState icon={Gauge} title="No quota policies yet.">
          Usage is unlimited until a policy is applied to a role. Budget policies need per-model
          prices, which are set in the model catalog.
        </EmptyState>
      )}

      <ConfirmDialog
        open={Boolean(deleteFor)}
        onOpenChange={(open) => !open && setDeleteFor(null)}
        title={`Delete ${deleteFor?.name ?? 'policy'}?`}
        description={
          deleteFor && deleteFor.overrideCount > 0
            ? `The roles it applies to will no longer be limited by it, and its ${deleteFor.overrideCount} per-user override${deleteFor.overrideCount === 1 ? '' : 's'} will be removed. This action cannot be undone.`
            : 'The roles it applies to will no longer be limited by it. This action cannot be undone.'
        }
        confirmLabel="Delete policy"
        pendingLabel="Deleting…"
        errorMessage="The quota policy could not be deleted."
        onConfirm={() => (deleteFor ? deletePolicy(deleteFor) : Promise.resolve())}
      />

      <Dialog open={Boolean(formFor)} onOpenChange={(open) => !open && setFormFor(null)}>
        {formFor && <QuotaPolicyDialog policy={formFor.policy} onClose={() => setFormFor(null)} />}
      </Dialog>
    </div>
  );
}
