import {
  type CapacityLimits,
  capacityLimitsSchema,
  type ProviderCapacityOverview,
  QUEUE_PRIORITIES,
  type QueuePriority,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { EditableFieldset, EditOnly } from '~/components/admin/admin-access';
import { LoadError, SaveRow } from '~/components/admin/admin-ui';
import { useEditedSince, useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import {
  type FieldProblem,
  problemsAt,
  problemsElsewhere,
  useFieldProblems,
} from '~/hooks/use-clear-on-edit';
import { api, apiErrorMessage, apiErrorProblems } from '~/lib/api-client';

/**
 * Provider capacity (v0.11): limits OCI keeps below a provider's own rate
 * limits, shared by every replica, and the queue turns wait in when they are
 * reached. Edited per provider and per model; the queue's settings and its
 * live state sit on the Providers tab.
 */

export const CAPACITY_QUERY_KEY = ['admin', 'capacity'] as const;

export function useCapacityOverview() {
  return useQuery({
    queryKey: CAPACITY_QUERY_KEY,
    queryFn: () => api.get<ProviderCapacityOverview>('/admin/providers/capacity'),
    refetchInterval: 15_000,
  });
}

const number = (value: number | undefined) => (value ?? 0).toLocaleString('en-US');

/** "60 requests/min · 2 streams", or "No limits". */
export function limitsSummary(limits: CapacityLimits | undefined): string {
  if (!limits) return 'No limits';
  const parts = [
    limits.requestsPerMinute !== null ? `${number(limits.requestsPerMinute)} requests/min` : null,
    limits.tokensPerMinute !== null ? `${number(limits.tokensPerMinute)} tokens/min` : null,
    limits.maxConcurrentStreams !== null
      ? `${number(limits.maxConcurrentStreams)} stream${limits.maxConcurrentStreams === 1 ? '' : 's'} at once`
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No limits';
}

type LimitField = keyof CapacityLimits;
const FIELDS: Array<{ key: LimitField; label: string; hint: string }> = [
  {
    key: 'requestsPerMinute',
    label: 'Requests per minute',
    hint: 'Every model request counts, including each tool step of a reply.',
  },
  {
    key: 'tokensPerMinute',
    label: 'Tokens per minute',
    hint: 'Input and output. Estimated before a request (input plus the reserved output), then corrected with the reported usage.',
  },
  {
    key: 'maxConcurrentStreams',
    label: 'Replies at once',
    hint: 'Replies streaming at the same time, across every replica.',
  },
];

export interface CapacityTarget {
  kind: 'provider' | 'model';
  id: string;
  name: string;
  limits: CapacityLimits | undefined;
}

export function CapacityLimitsDialog({
  target,
  onClose,
}: {
  target: CapacityTarget;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<LimitField, string>>(() => ({
    requestsPerMinute: target.limits?.requestsPerMinute?.toString() ?? '',
    tokensPerMinute: target.limits?.tokensPerMinute?.toString() ?? '',
    maxConcurrentStreams: target.limits?.maxConcurrentStreams?.toString() ?? '',
  }));
  // A correction clears the complaint about that field (#178) and leaves the
  // others listed while their fields are still wrong (#257).
  const [problems, setProblems] = useFieldProblems(values);
  // Each at its field (#302); one about no field (a failed save) at the foot.
  const at = (key: LimitField) => problemsAt(problems, key);
  const error = problemsElsewhere(
    problems,
    FIELDS.map(({ key }) => key),
  );
  const edited = useEditedSince(values);
  const save = useMutation({
    mutationFn: (limits: CapacityLimits) =>
      api.put(
        `/admin/${target.kind === 'provider' ? 'providers' : 'models'}/${target.id}/capacity`,
        limits,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CAPACITY_QUERY_KEY });
      onClose();
    },
    onError: (cause) => setProblems(apiErrorProblems(cause, 'The limits could not be saved.')),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setProblems([]);
    const limits = {} as CapacityLimits;
    // Every field is checked, and every problem listed at once, as Add model
    // does (#129): one per save made correcting three fields take three (#226).
    const problems: FieldProblem[] = [];
    for (const { key, label } of FIELDS) {
      const raw = values[key].replace(/[,\s]/g, '');
      if (!raw) {
        limits[key] = null;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        problems.push({
          fields: [key],
          text: `${label} must be a whole number of at least 1, or empty for no limit.`,
        });
        continue;
      }
      limits[key] = parsed;
    }
    // The API's maximums too, so a number too large is reported with one
    // that is not a number rather than one save later (#320).
    const checked = capacityLimitsSchema.safeParse(limits);
    for (const issue of checked.success ? [] : checked.error.issues) {
      const key = String(issue.path[0]);
      if (!problems.some((problem) => problem.fields[0] === key)) {
        problems.push({ fields: [key], text: issue.message });
      }
    }
    if (problems.length > 0) {
      setProblems(problems);
      return;
    }
    save.mutate(limits);
  }

  return (
    <DialogContent confirmDiscard={edited}>
      <DialogHeader>
        <DialogTitle>Capacity limits for {target.name}</DialogTitle>
        <DialogDescription>
          {target.kind === 'provider'
            ? 'Shared by all of this provider’s models. Set them a little below the provider’s own limits.'
            : 'Applied on top of the provider’s limits, for this model only.'}{' '}
          Leave a field empty for no limit. When a limit is reached, messages wait their turn
          instead of failing.
        </DialogDescription>
      </DialogHeader>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        {FIELDS.map((field) => (
          <Field
            key={field.key}
            label={field.label}
            htmlFor={`capacity-${field.key}`}
            hint={field.hint}
            error={at(field.key)}
          >
            <Input
              id={`capacity-${field.key}`}
              {...invalidFieldProps(`capacity-${field.key}`, at(field.key))}
              inputMode="numeric"
              value={values[field.key]}
              placeholder="No limit"
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
          </Field>
        ))}
        {error && (
          <p
            role="alert"
            className="whitespace-pre-line rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
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
            Save limits
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** A button that opens the limits dialog for one provider or model. */
export function CapacityLimitsButton({ target }: { target: Omit<CapacityTarget, 'limits'> }) {
  const overview = useCapacityOverview();
  const [open, setOpen] = useState(false);
  const limits =
    target.kind === 'provider'
      ? overview.data?.providers.find((provider) => provider.providerId === target.id)?.limits
      : overview.data?.providers
          .flatMap((provider) => provider.models ?? [])
          .find((model) => model.modelId === target.id)?.limits;
  return (
    <EditOnly>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Capacity limits for ${target.name}`}
        title={limitsSummary(limits)}
        disabled={!overview.data}
        onClick={() => setOpen(true)}
      >
        <Gauge />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && overview.data && (
          <CapacityLimitsDialog target={{ ...target, limits }} onClose={() => setOpen(false)} />
        )}
      </Dialog>
    </EditOnly>
  );
}

const PRIORITY_LABELS: Record<QueuePriority, string> = {
  high: 'High (a minute ahead)',
  normal: 'Normal',
  low: 'Low (a minute behind)',
};
const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrators',
  auditor: 'Auditors',
  // "User" everywhere else in administration (#86).
  user: 'Users',
  restricted: 'Restricted',
};

/**
 * The queue's settings and every provider's state now: who waits, how long
 * they waited in the last hour, and how often the provider asked OCI to slow
 * down. Refreshed every 15 seconds.
 */
export function ProviderCapacitySection() {
  const queryClient = useQueryClient();
  const overview = useCapacityOverview();
  const [maxWait, setMaxWait] = useState('');
  const [priority, setPriority] = useState<Record<UserRole, QueuePriority> | null>(null);
  const [saved, setSaved] = useState(false);
  const queue = overview.data?.queue;
  useEffect(() => {
    if (!queue) return;
    setMaxWait(String(queue.maxWaitSeconds));
    setPriority(queue.rolePriority);
  }, [queue]);

  const save = useMutation({
    mutationFn: (body: { maxWaitSeconds: number; rolePriority: Record<UserRole, QueuePriority> }) =>
      api.put('/admin/providers/capacity', body),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: CAPACITY_QUERY_KEY });
    },
  });
  // Shown under the field and described by it, not beside Save (#302).
  const [waitError, setWaitError] = useState<string | null>(null);
  const changed =
    Boolean(queue && priority) &&
    (maxWait !== String(queue?.maxWaitSeconds) ||
      USER_ROLES.some((role) => priority?.[role] !== queue?.rolePriority[role]));
  // Leaving the page asks first, as every admin form does (#45, #300).
  useReportUnsaved(changed);

  function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    setWaitError(null);
    const seconds = Number(maxWait);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 1800) {
      setWaitError('The longest wait must be between 5 and 1,800 seconds.');
      return;
    }
    if (priority) save.mutate({ maxWaitSeconds: seconds, rolePriority: priority });
  }

  return (
    <section
      aria-labelledby="capacity-heading"
      className="mt-4 flex flex-col gap-5 border-t border-[var(--border-subtle)] pt-8"
    >
      <div className="min-w-0">
        <h2 id="capacity-heading" className="text-base font-semibold text-[var(--text-primary)]">
          Capacity
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
          Limits per provider and model (the gauge buttons) keep OCI below the provider’s rate
          limits. Messages over them wait their turn, fairly between people, and see their place; a
          provider that still answers “too many requests” is retried after the time it asks for.
        </p>
      </div>

      {overview.isLoading ? (
        <div className="py-4" role="status" aria-label="Loading capacity">
          <Spinner className="mx-auto size-5" />
        </div>
      ) : overview.isError || !overview.data ? (
        <LoadError title="Capacity could not be loaded." query={overview} />
      ) : (
        <>
          {overview.data.enforcement === 'local' && (
            <p role="note" className="text-sm text-[var(--warning-foreground,var(--text-muted))]">
              Redis is not available, so each replica enforces the limits on its own.
            </p>
          )}
          {overview.data.providers.length > 0 && (
            <section
              // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
              tabIndex={0}
              aria-label="Capacity by provider"
              className="overflow-x-auto"
            >
              <table className="w-full min-w-[36rem] text-left text-sm">
                <caption className="sr-only">Capacity by provider</caption>
                <thead className="text-xs text-[var(--text-muted)]">
                  <tr>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Provider
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Limits
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Waiting
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Streaming
                    </th>
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Waited (1 h)
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      Throttled (1 h)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.data.providers.map((provider, index) => {
                    const limitedModels = (provider.models ?? []).filter(
                      (model) => limitsSummary(model.limits) !== 'No limits',
                    );
                    return (
                      <tr
                        key={provider.providerId ?? index}
                        className="border-t border-[var(--border-subtle)] align-top"
                      >
                        <th scope="row" className="py-2 pr-4 font-medium">
                          {provider.label}
                        </th>
                        <td className="py-2 pr-4 text-[var(--text-secondary)]">
                          {limitsSummary(provider.limits)}
                          {limitedModels.map((model) => (
                            <span
                              key={model.modelId}
                              className="block text-xs text-[var(--text-muted)]"
                            >
                              {model.displayName}: {limitsSummary(model.limits)}
                            </span>
                          ))}
                        </td>
                        <td className="py-2 pr-4">{number(provider.queued)}</td>
                        <td className="py-2 pr-4">{number(provider.activeStreams)}</td>
                        <td className="py-2 pr-4">
                          {number(provider.waitsLastHour)}
                          {provider.longestWaitSeconds !== null &&
                            ` (longest ${number(provider.longestWaitSeconds)} s)`}
                        </td>
                        <td className="py-2">
                          {number(provider.throttledLastHour)}
                          {provider.coolingUntil && (
                            <span className="block text-xs text-[var(--text-muted)]">
                              Paused until {new Date(provider.coolingUntil).toLocaleTimeString()}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          <EditableFieldset>
            <form noValidate onSubmit={submit} className="flex flex-col gap-4">
              <Field
                label="Longest wait (seconds)"
                htmlFor="capacity-max-wait"
                hint="A message that waits longer fails with a message to try again later."
                error={waitError}
              >
                <Input
                  id="capacity-max-wait"
                  {...invalidFieldProps('capacity-max-wait', waitError)}
                  inputMode="numeric"
                  value={maxWait}
                  onChange={(event) => {
                    setSaved(false);
                    // Editing the value clears the complaint about it, which
                    // otherwise stayed while Save was disabled (#178).
                    setWaitError(null);
                    save.reset();
                    setMaxWait(event.target.value);
                  }}
                  className="max-w-40"
                />
              </Field>
              <div>
                <p className="mb-2 text-sm text-[var(--text-secondary)]">Queue priority by role</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {USER_ROLES.map((role) => (
                    <Field
                      key={role}
                      label={ROLE_LABELS[role]}
                      htmlFor={`capacity-priority-${role}`}
                    >
                      <Select
                        id={`capacity-priority-${role}`}
                        value={priority?.[role] ?? 'normal'}
                        onChange={(next) => {
                          setSaved(false);
                          save.reset();
                          setPriority((current) =>
                            current ? { ...current, [role]: next as QueuePriority } : current,
                          );
                        }}
                        options={QUEUE_PRIORITIES.map((value) => ({
                          value,
                          label: PRIORITY_LABELS[value],
                        }))}
                      />
                    </Field>
                  ))}
                </div>
              </div>
              <SaveRow
                hasChanges={changed}
                isPending={save.isPending}
                errorMessage={
                  save.error
                    ? apiErrorMessage(save.error, 'The queue settings could not be saved.')
                    : null
                }
                successMessage={saved && !changed ? 'Queue settings saved.' : null}
              />
            </form>
          </EditableFieldset>
        </>
      )}
    </section>
  );
}
