import {
  type AdminUser,
  MICROS_PER_DOLLAR,
  type QuotaMetric,
  type QuotaOverride,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api, apiErrorMessage } from '~/lib/api-client';

/** Cost is stored in micro-dollars; the other metrics are plain counts. */
function toDisplay(value: number, metric: QuotaMetric): string {
  return metric === 'cost' ? (value / MICROS_PER_DOLLAR).toFixed(2) : String(value);
}

/** For reading, not the input: "1,000,000 messages", "$12.50", as elsewhere (#80). */
function toReadable(value: number, metric: QuotaMetric): string {
  return metric === 'cost'
    ? (value / MICROS_PER_DOLLAR).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : value.toLocaleString('en-US');
}

function fromDisplay(value: string, metric: QuotaMetric): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Number.NaN;
  return metric === 'cost' ? Math.round(parsed * MICROS_PER_DOLLAR) : Math.round(parsed);
}

function unitLabel(metric: QuotaMetric): string {
  if (metric === 'cost') return 'US dollars';
  return metric === 'tokens' ? 'tokens' : 'messages';
}

/**
 * Adjusts what one person is allowed, for policies their role already carries.
 *
 * Managed from the user rather than the policy: granting someone headroom is a
 * decision about that person, and this is where an administrator already is
 * when they make it.
 */
export function QuotaOverrideDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<
    Record<string, { limit: string; expiresAt: string; reason: string }>
  >({});
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', user.id, 'quota-overrides'],
    queryFn: () =>
      api.get<{ overrides: QuotaOverride[] }>(`/admin/users/${user.id}/quota-overrides`),
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin', 'users', user.id, 'quota-overrides'] }),
      // The user's limits summary shows the adjusted allowance behind this dialog.
      queryClient.invalidateQueries({ queryKey: ['admin', 'users', user.id, 'limits'] }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'quotas'] }),
    ]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.put(`/admin/users/${user.id}/quota-overrides`, body),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    // "Expires", as the field is labelled, not "Expires at" (#228).
    onError: (cause) =>
      setError(
        apiErrorMessage(cause, 'The override could not be saved.', {
          limitValue: 'Limit',
          expiresAt: 'Expires',
          reason: 'Reason',
        }),
      ),
  });

  const clear = useMutation({
    mutationFn: (policyId: string) =>
      api.delete(`/admin/users/${user.id}/quota-overrides/${policyId}`),
    onSuccess: invalidate,
  });

  const entries = data?.overrides ?? [];

  return (
    <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Usage limits for {user.name}</DialogTitle>
        <DialogDescription>
          Adjust what this person is allowed, for the policies their role already carries. Leave a
          limit unchanged to keep the role default.
        </DialogDescription>
      </DialogHeader>

      {isLoading && <Spinner className="mx-auto size-5" />}

      {!isLoading && entries.length === 0 && (
        <p className="text-[var(--text-muted)] text-sm">
          No usage limits apply to this person&rsquo;s role, so there is nothing to adjust.
        </p>
      )}

      <div className="flex flex-col gap-5">
        {entries.map((entry) => {
          const draft = drafts[entry.policyId] ?? {
            limit: toDisplay(entry.limitValue, entry.metric),
            expiresAt: entry.expiresAt ? entry.expiresAt.slice(0, 10) : '',
            reason: entry.reason ?? '',
          };
          const overridden = entry.limitValue !== entry.roleLimitValue;

          return (
            <div
              key={entry.policyId}
              className="border-[var(--border-subtle)] border-b pb-5 last:border-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium text-sm">{entry.policyName}</h3>
                <p className="text-[var(--text-muted)] text-xs">
                  Role default: {toReadable(entry.roleLimitValue, entry.metric)}{' '}
                  {unitLabel(entry.metric)}
                  {overridden && !entry.active ? ' \u00b7 override expired' : ''}
                </p>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field
                  label={`Limit (${unitLabel(entry.metric)})`}
                  htmlFor={`limit-${entry.policyId}`}
                >
                  <Input
                    id={`limit-${entry.policyId}`}
                    type="number"
                    min={entry.metric === 'cost' ? '0.01' : '1'}
                    step={entry.metric === 'cost' ? '0.01' : '1'}
                    value={draft.limit}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [entry.policyId]: { ...draft, limit: event.target.value },
                      }))
                    }
                  />
                </Field>

                <Field
                  label="Expires"
                  htmlFor={`expires-${entry.policyId}`}
                  hint="Blank never expires."
                >
                  <Input
                    id={`expires-${entry.policyId}`}
                    type="date"
                    value={draft.expiresAt}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [entry.policyId]: { ...draft, expiresAt: event.target.value },
                      }))
                    }
                  />
                </Field>

                <Field label="Reason" htmlFor={`reason-${entry.policyId}`}>
                  <Input
                    id={`reason-${entry.policyId}`}
                    placeholder="Why this is needed"
                    value={draft.reason}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [entry.policyId]: { ...draft, reason: event.target.value },
                      }))
                    }
                  />
                </Field>
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                {overridden && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={clear.isPending}
                    onClick={() => {
                      setDrafts((current) => {
                        const next = { ...current };
                        delete next[entry.policyId];
                        return next;
                      });
                      clear.mutate(entry.policyId);
                    }}
                  >
                    Reset to default
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={save.isPending}
                  onClick={() => {
                    const limitValue = fromDisplay(draft.limit, entry.metric);
                    if (Number.isNaN(limitValue)) {
                      setError('Enter a limit greater than zero.');
                      return;
                    }
                    save.mutate({
                      policyId: entry.policyId,
                      limitValue,
                      // Dates arrive as a plain day; send the end of it so an
                      // override lasts through the date an admin picked.
                      expiresAt: draft.expiresAt
                        ? new Date(`${draft.expiresAt}T23:59:59`).toISOString()
                        : null,
                      reason: draft.reason.trim() || null,
                    });
                  }}
                >
                  {save.isPending && <Spinner />}
                  Save
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-[var(--danger-on-tint)] text-xs"
        >
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
