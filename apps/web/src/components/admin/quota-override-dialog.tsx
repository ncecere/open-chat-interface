import {
  type AdminUser,
  MICROS_PER_DOLLAR,
  type QuotaMetric,
  type QuotaOverride,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import {
  type FieldProblem,
  problemsAt,
  problemsElsewhere,
  useFieldProblems,
} from '~/hooks/use-clear-on-edit';
import { api, apiErrorProblems } from '~/lib/api-client';

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

/** "Expires", as the field is labelled, not "Expires at" (#228). */
const OVERRIDE_LABELS = { limitValue: 'Limit', expiresAt: 'Expires', reason: 'Reason' };

/** The form's field for each field the API names, per budget: `<policyId>:limit` (#283). */
const FORM_FIELDS: Record<string, string> = {
  limitValue: 'limit',
  expiresAt: 'expiresAt',
  reason: 'reason',
};
const fieldOf = (policyId: string, field: string) => `${policyId}:${field}`;

type OverrideDraft = { limit: string; expiresAt: string; reason: string };

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
  const [drafts, setDrafts] = useState<Record<string, OverrideDraft>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users', user.id, 'quota-overrides'],
    queryFn: () =>
      api.get<{ overrides: QuotaOverride[] }>(`/admin/users/${user.id}/quota-overrides`),
  });
  const entries = data?.overrides ?? [];
  const draftFor = (entry: QuotaOverride): OverrideDraft =>
    drafts[entry.policyId] ?? {
      limit: toDisplay(entry.limitValue, entry.metric),
      expiresAt: entry.expiresAt ? entry.expiresAt.slice(0, 10) : '',
      reason: entry.reason ?? '',
    };

  // Every budget's fields, keyed `<policyId>:<field>`: an error is shown under
  // the field it is about, marked invalid, and goes once that field is
  // corrected, not at the next Save (#178, #217, #283).
  const values = Object.fromEntries(
    entries.flatMap((entry) =>
      Object.entries(draftFor(entry)).map(([field, value]) => [
        fieldOf(entry.policyId, field),
        value,
      ]),
    ),
  );
  const fieldsArea = useRef<HTMLDivElement>(null);
  const [problems, setProblems] = useFieldProblems(values, fieldsArea);
  const error = problemsElsewhere(problems, Object.keys(values));
  /** One budget's problems replaced by `next`, keeping the other budgets'. */
  const reportFor = (policyId: string, next: FieldProblem[]) =>
    setProblems([
      ...problems.filter((problem) => !problem.fields[0]?.startsWith(`${policyId}:`)),
      ...next,
    ]);

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
    onSuccess: async (_, body) => {
      reportFor(String(body.policyId), []);
      await invalidate();
    },
    onError: (cause, body) => {
      const policyId = String(body.policyId);
      reportFor(
        policyId,
        apiErrorProblems(cause, 'The override could not be saved.', OVERRIDE_LABELS).map(
          // One about no field (a failed save) is still this budget's, so its
          // next Save replaces it; it is shown at the foot.
          (problem) => ({
            ...problem,
            fields:
              problem.fields.length === 0
                ? [fieldOf(policyId, '')]
                : problem.fields.map((field) => fieldOf(policyId, FORM_FIELDS[field] ?? field)),
          }),
        ),
      );
    },
  });

  const clear = useMutation({
    mutationFn: (policyId: string) =>
      api.delete(`/admin/users/${user.id}/quota-overrides/${policyId}`),
    onSuccess: invalidate,
  });

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

      <div ref={fieldsArea} className="flex flex-col gap-5">
        {entries.map((entry) => {
          const draft = draftFor(entry);
          const at = (field: keyof OverrideDraft) =>
            problemsAt(problems, fieldOf(entry.policyId, field));
          const overridden = entry.limitValue !== entry.roleLimitValue;

          return (
            // Each budget's fields and buttons are named for the budget, as the
            // same Limit, Expires, Reason, Save and Reset repeat for each (#260).
            <fieldset
              key={entry.policyId}
              aria-labelledby={`override-${entry.policyId}`}
              className="min-w-0 border-[var(--border-subtle)] border-b pb-5 last:border-0"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 id={`override-${entry.policyId}`} className="font-medium text-sm">
                  {entry.policyName}
                </h3>
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
                  error={at('limit')}
                >
                  <Input
                    id={`limit-${entry.policyId}`}
                    {...invalidFieldProps(`limit-${entry.policyId}`, at('limit'))}
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
                  error={at('expiresAt')}
                >
                  <Input
                    id={`expires-${entry.policyId}`}
                    {...invalidFieldProps(`expires-${entry.policyId}`, at('expiresAt'))}
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

                <Field label="Reason" htmlFor={`reason-${entry.policyId}`} error={at('reason')}>
                  <Input
                    id={`reason-${entry.policyId}`}
                    {...invalidFieldProps(`reason-${entry.policyId}`, at('reason'))}
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
                    aria-label={`Reset to default for ${entry.policyName}`}
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
                  aria-label={`Save override for ${entry.policyName}`}
                  onClick={() => {
                    const limitValue = fromDisplay(draft.limit, entry.metric);
                    if (Number.isNaN(limitValue)) {
                      reportFor(entry.policyId, [
                        {
                          fields: [fieldOf(entry.policyId, 'limit')],
                          text: 'Enter a limit greater than zero.',
                        },
                      ]);
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
            </fieldset>
          );
        })}
      </div>

      {error && (
        <p
          role="alert"
          className="whitespace-pre-line rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-[var(--danger-on-tint)] text-xs"
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
