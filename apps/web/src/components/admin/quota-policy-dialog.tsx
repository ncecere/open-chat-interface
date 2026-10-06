import {
  MICROS_PER_DOLLAR,
  QUOTA_METRICS,
  QUOTA_WINDOW_KINDS,
  type QuotaMetric,
  type QuotaPolicy,
  type QuotaWindowKind,
  USER_ROLES,
  type UserRole,
  upsertQuotaPolicySchema,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ModelScopePicker } from '~/components/admin/model-scope-picker';
import { Button } from '~/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api, apiErrorMessage } from '~/lib/api-client';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import { cn } from '~/lib/utils';
import { validationText } from '~/lib/validation-issues';

const METRIC_LABELS: Record<QuotaMetric, string> = {
  messages: 'Messages',
  tokens: 'Tokens',
  cost: 'Budget (dollars)',
};

const METRIC_HINTS: Record<QuotaMetric, string> = {
  messages: 'Counts each generated response.',
  tokens: 'Counts input plus output tokens.',
  cost: 'Counts spend using the per-model prices in the model catalog.',
};

const WINDOW_LABELS: Record<QuotaWindowKind, string> = {
  rolling: 'Rolling window',
  daily: 'Daily (resets at midnight)',
  weekly: 'Weekly (resets Sunday)',
  monthly: 'Monthly (resets on the 1st)',
};

/** The dialog's names for the fields, as the schema names them (#127). */
const POLICY_LABELS = {
  metric: 'Measure',
  limitValue: 'Limit',
  windowKind: 'Window',
  windowHours: 'Window length (hours)',
  timezone: 'Reset timezone',
  roles: 'Applies to roles',
  modelSlugs: 'Applies to models',
};

/** A short, dependency-free list covering the common deployment zones. */
const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
];

interface PolicyDraft {
  name: string;
  description: string;
  metric: QuotaMetric;
  /** Dollars for cost policies, raw counts otherwise. */
  limitValue: string;
  windowKind: QuotaWindowKind;
  windowHours: string;
  timezone: string;
  enabled: boolean;
  roles: UserRole[];
  /** Empty applies the policy to every model. */
  modelSlugs: string[];
}

function initialDraft(policy: QuotaPolicy | null): PolicyDraft {
  if (!policy) {
    return {
      name: '',
      description: '',
      metric: 'messages',
      limitValue: '',
      windowKind: 'daily',
      windowHours: '24',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      enabled: true,
      roles: ['user'],
      modelSlugs: [],
    };
  }

  return {
    name: policy.name,
    description: policy.description ?? '',
    metric: policy.metric,
    limitValue:
      policy.metric === 'cost'
        ? (policy.limitValue / MICROS_PER_DOLLAR).toString()
        : policy.limitValue.toString(),
    windowKind: policy.windowKind,
    windowHours: policy.windowHours?.toString() ?? '24',
    timezone: policy.timezone,
    enabled: policy.enabled,
    roles: policy.roles,
    modelSlugs: policy.modelSlugs,
  };
}

/** Dollars are converted to integer micro-dollars so no money is ever a float. */
function toLimitValue(draft: PolicyDraft): number {
  const parsed = Number(draft.limitValue);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return draft.metric === 'cost' ? Math.round(parsed * MICROS_PER_DOLLAR) : Math.round(parsed);
}

export function QuotaPolicyDialog({
  policy,
  onClose,
}: {
  policy: QuotaPolicy | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => initialDraft(policy));
  // Compared as JSON: the draft is plain data, and only a real edit counts.
  const [initial] = useState(() => JSON.stringify(initialDraft(policy)));
  const edited = JSON.stringify(draft) !== initial;
  const [error, setError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(error, () => setError(null));

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      policy ? api.put(`/admin/quotas/${policy.id}`, body) : api.post('/admin/quotas', body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'quotas'] }),
        queryClient.invalidateQueries({ queryKey: ['me', 'usage'] }),
      ]);
      onClose();
    },
    onError: (cause) =>
      setError(apiErrorMessage(cause, 'The budget could not be saved.', POLICY_LABELS)),
  });

  const isRolling = draft.windowKind === 'rolling';

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = upsertQuotaPolicySchema.safeParse({
      name: draft.name,
      description: draft.description.trim() || null,
      metric: draft.metric,
      limitValue: toLimitValue(draft),
      windowKind: draft.windowKind,
      windowHours: isRolling ? Number(draft.windowHours || 24) : null,
      timezone: draft.timezone,
      enabled: draft.enabled,
      roles: draft.roles,
      modelSlugs: draft.modelSlugs,
    });

    if (!parsed.success) {
      setError(validationText(parsed.error.issues, 'Check the budget fields.', POLICY_LABELS));
      return;
    }
    save.mutate(parsed.data);
  }

  return (
    <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" confirmDiscard={edited}>
      <DialogHeader>
        <DialogTitle>{policy ? 'Edit budget' : 'New budget'}</DialogTitle>
        <DialogDescription>
          A budget sets one limit over one window. Apply it to the roles that should share it, and
          optionally to specific models so a family such as Anthropic carries its own.
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label="Name" htmlFor="policy-name">
          <Input
            id="policy-name"
            value={draft.name}
            placeholder="Standard daily allowance"
            required
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </Field>

        <Field label="Description" htmlFor="policy-description">
          <Textarea
            id="policy-description"
            rows={2}
            value={draft.description}
            onChange={(event) =>
              setDraft((current) => ({ ...current, description: event.target.value }))
            }
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Measure" htmlFor="policy-metric" hint={METRIC_HINTS[draft.metric]}>
            <Select
              id="policy-metric"
              value={draft.metric}
              onChange={(next) =>
                setDraft((current) => ({ ...current, metric: next as QuotaMetric }))
              }
              options={QUOTA_METRICS.map((metric) => ({
                value: metric,
                label: METRIC_LABELS[metric],
              }))}
            />
          </Field>

          <Field
            label={draft.metric === 'cost' ? 'Limit (US dollars)' : 'Limit'}
            htmlFor="policy-limit"
          >
            <Input
              id="policy-limit"
              type="number"
              min={draft.metric === 'cost' ? '0.01' : '1'}
              step={draft.metric === 'cost' ? '0.01' : '1'}
              value={draft.limitValue}
              placeholder={draft.metric === 'cost' ? '25.00' : '500'}
              required
              onChange={(event) =>
                setDraft((current) => ({ ...current, limitValue: event.target.value }))
              }
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Window" htmlFor="policy-window">
            <Select
              id="policy-window"
              value={draft.windowKind}
              onChange={(next) =>
                setDraft((current) => ({ ...current, windowKind: next as QuotaWindowKind }))
              }
              options={QUOTA_WINDOW_KINDS.map((kind) => ({
                value: kind,
                label: WINDOW_LABELS[kind],
              }))}
            />
          </Field>

          {isRolling ? (
            <Field
              label="Window length (hours)"
              htmlFor="policy-window-hours"
              hint="Usage frees up continuously as it ages out."
            >
              <Input
                id="policy-window-hours"
                type="number"
                min="1"
                // The API's limit (a year), so the browser says so before saving (#127).
                max="8760"
                step="1"
                value={draft.windowHours}
                required
                onChange={(event) =>
                  setDraft((current) => ({ ...current, windowHours: event.target.value }))
                }
              />
            </Field>
          ) : (
            <Field
              label="Reset timezone"
              htmlFor="policy-timezone"
              hint="Calendar windows reset at midnight in this zone."
            >
              <Select
                id="policy-timezone"
                value={draft.timezone}
                onChange={(timezone) => setDraft((current) => ({ ...current, timezone }))}
                options={[...new Set([draft.timezone, ...COMMON_TIMEZONES])].map((zone) => ({
                  value: zone,
                  label: zone,
                }))}
              />
            </Field>
          )}
        </div>

        <Field label="Applies to roles" htmlFor="policy-roles">
          <div id="policy-roles" className="flex flex-wrap gap-1.5">
            {USER_ROLES.map((role) => {
              const selected = draft.roles.includes(role);
              return (
                <button
                  key={role}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      roles: selected
                        ? current.roles.filter((entry) => entry !== role)
                        : [...current.roles, role],
                    }))
                  }
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors',
                    selected
                      ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                      : 'bg-[var(--bg-control-alt)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                  )}
                >
                  {role}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Applies to models">
          <ModelScopePicker
            selected={draft.modelSlugs}
            onChange={(modelSlugs) => setDraft((current) => ({ ...current, modelSlugs }))}
          />
        </Field>

        <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
          <div>
            <label htmlFor="policy-enabled" className="text-sm font-medium">
              Enforced
            </label>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Turn off to keep the budget without applying it.
            </p>
          </div>
          <Switch
            id="policy-enabled"
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
          />
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {policy ? 'Save changes' : 'Create budget'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
