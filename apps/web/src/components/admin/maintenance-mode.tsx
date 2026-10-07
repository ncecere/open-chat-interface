import {
  type MaintenanceSettings,
  type UpdateMaintenanceInput,
  updateMaintenanceSchema,
} from '@oci/shared';
import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Lock, LockOpen } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useAdminAccess } from '~/components/admin/admin-access';
import { LoadError, MutationError, Notice, SettingsSection } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { api } from '~/lib/api-client';
import { formatReadOnlyTime, setReadOnlyStatus } from '~/lib/read-only';
import { formatRelativeTime } from '~/lib/utils';
import { validationProblems } from '~/lib/validation-issues';

export const MAINTENANCE_QUERY_KEY = ['admin', 'maintenance'] as const;

/** An ISO time as a `datetime-local` value, in this browser's zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value (this browser's zone) as ISO, or null when empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The switch form's names for the fields the API checks. */
const SWITCH_LABELS = { reason: 'Reason shown to people', until: 'Expected end' };

const SOURCE_LABELS = {
  environment: 'the OCI_READ_ONLY environment variable',
  administrator: 'an administrator',
  schedule: 'the scheduled window',
} as const;

/**
 * System health, Maintenance (v0.11 design, section 9): read-only mode, a
 * scheduled window with its announcement, and the background jobs that keep
 * running. Its controls stay usable while read-only (unlike every other admin
 * form) so an administrator can turn it off; auditors see it without them.
 */
export function MaintenanceMode() {
  const settings = useQuery({
    queryKey: MAINTENANCE_QUERY_KEY,
    queryFn: () => api.get<MaintenanceSettings>('/admin/maintenance'),
    refetchInterval: 30_000,
  });

  return (
    <SettingsSection
      editable={false}
      title="Maintenance"
      description="Read-only mode keeps reading, searching, exporting and signing in working and refuses every change, on every replica at once: use it for an upgrade or a database move that needs a window. Replies already being written finish."
    >
      {settings.isLoading ? (
        <div role="status" aria-label="Loading maintenance settings">
          <Spinner className="mx-auto size-5" />
        </div>
      ) : settings.data ? (
        <MaintenanceForm settings={settings.data} />
      ) : (
        <LoadError title="Maintenance settings could not be loaded." query={settings} />
      )}
    </SettingsSection>
  );
}

function MaintenanceForm({ settings }: { settings: MaintenanceSettings }) {
  const queryClient = useQueryClient();
  // Not canEdit: that is off while read-only, and this is the way back.
  const isAdmin = useAdminAccess().role === 'admin';
  const save = useMutation({
    mutationFn: (input: UpdateMaintenanceInput) =>
      api.put<MaintenanceSettings>('/admin/maintenance', input),
    onSuccess: (next) => {
      queryClient.setQueryData(MAINTENANCE_QUERY_KEY, next);
      // This tab follows at once; the others within their next poll.
      setReadOnlyStatus(next.status);
      // The Health checks row above says whether read-only is on (#222).
      void queryClient.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <Status settings={settings} />
      {settings.environmentLocked && (
        <Notice tone="warning" title="Read-only by the environment">
          OCI_READ_ONLY is set on this replica, so the instance stays read-only whatever is chosen
          here. Unset it on every replica (and worker) and restart them to end it.
        </Notice>
      )}
      {/* Remounted on each switch, so the form starts empty every time (#222). */}
      {isAdmin && <Switch key={String(settings.readOnly)} settings={settings} save={save} />}
      {/* Remounted when the saved window changes (scheduled, cancelled, or by
          another administrator), so its fields show it and are not taken
          for unsaved edits (#300). */}
      {isAdmin && (
        <ScheduledWindow key={JSON.stringify(settings.window)} settings={settings} save={save} />
      )}
      <Jobs settings={settings} save={save} editable={isAdmin} />
      <MutationError error={save.error} message="The change could not be saved." />
    </div>
  );
}

type Save = UseMutationResult<MaintenanceSettings, Error, UpdateMaintenanceInput>;

function Status({ settings }: { settings: MaintenanceSettings }) {
  const { status } = settings;
  const Icon = status.active ? Lock : LockOpen;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] px-4 py-3 text-sm">
      <Icon
        className={
          status.active
            ? 'mt-0.5 size-4 shrink-0 text-[var(--warning)]'
            : 'mt-0.5 size-4 shrink-0 text-[var(--success)]'
        }
        aria-hidden="true"
      />
      <div className="min-w-0" aria-live="polite">
        <p className="font-medium">
          {status.active
            ? `Read-only, by ${SOURCE_LABELS[status.source ?? 'administrator']}`
            : 'Changes are allowed'}
          {status.active && status.until ? ` until about ${formatReadOnlyTime(status.until)}` : ''}
        </p>
        {status.reason && status.active && (
          <p className="text-[var(--text-muted)] text-xs">
            Reason shown to people: {status.reason}
          </p>
        )}
        {!status.active && status.window && (
          <p className="text-[var(--text-muted)] text-xs">
            Scheduled: read-only from {formatReadOnlyTime(status.window.startsAt)} until{' '}
            {formatReadOnlyTime(status.window.endsAt)}.
          </p>
        )}
        {settings.changedAt && (
          <p className="text-[var(--text-muted)] text-xs">
            Last switched {settings.readOnly ? 'on' : 'off'}{' '}
            {formatRelativeTime(settings.changedAt)}
            {settings.changedBy ? ` by ${settings.changedBy}` : ''}.
          </p>
        )}
      </div>
    </div>
  );
}

function Switch({ settings, save }: { settings: MaintenanceSettings; save: Save }) {
  const id = useId();
  // Empty, not the last window's reason: someone switching on in a hurry
  // would show people an old one (#222).
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [confirming, setConfirming] = useState(false);
  // Each problem under its field, marked invalid and described by it, until
  // that field is edited (#222, #302).
  const [problems, setProblems] = useFieldProblems({ reason, until });
  const at = (field: string) => problemsAt(problems, field);
  // Each form here asks before its edit is left behind (#45, #300).
  useReportUnsaved(reason !== '' || until !== '');

  if (settings.readOnly) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate({ readOnly: false })}
        >
          {save.isPending ? <Spinner /> : <LockOpen />}
          Turn off read-only mode
        </Button>
        {settings.status.source === 'schedule' || settings.environmentLocked ? null : (
          <p className="text-[var(--text-muted)] text-xs">
            Changes are accepted again on every replica as soon as it is off.
          </p>
        )}
      </div>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const input = { readOnly: true, reason: reason.trim() || null, until: fromLocalInput(until) };
    // An expected end in the past is refused here before the confirmation,
    // as the API refuses it (#222).
    const parsed = updateMaintenanceSchema.safeParse(input);
    if (!parsed.success) {
      setConfirming(false);
      setProblems(
        validationProblems(parsed.error.issues, SWITCH_LABELS).map(({ field, text }) => ({
          fields: field ? [field] : [],
          text,
        })),
      );
      return;
    }
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    save.mutate(input);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Reason shown to people"
          htmlFor={`${id}-reason`}
          hint="Optional, such as “Upgrading the database”."
          error={at('reason')}
        >
          <Input
            id={`${id}-reason`}
            {...invalidFieldProps(`${id}-reason`, at('reason'))}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <Field
          label="Expected end"
          htmlFor={`${id}-until`}
          hint="Optional. Shown to people and sent as Retry-After; nothing ends by itself."
          error={at('until')}
        >
          <Input
            id={`${id}-until`}
            {...invalidFieldProps(`${id}-until`, at('until'))}
            type="datetime-local"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </Field>
      </div>
      {problemsElsewhere(problems, ['reason', 'until']) && (
        <p role="alert" className="text-[var(--danger)] text-sm">
          {problemsElsewhere(problems, ['reason', 'until'])}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant={confirming ? 'danger' : 'secondary'}
          disabled={save.isPending}
        >
          {save.isPending ? <Spinner /> : <Lock />}
          {confirming ? 'Confirm: refuse every change now' : 'Turn on read-only mode'}
        </Button>
        {confirming && (
          <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function ScheduledWindow({ settings, save }: { settings: MaintenanceSettings; save: Save }) {
  const id = useId();
  const [startsAt, setStartsAt] = useState(toLocalInput(settings.window?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(settings.window?.endsAt ?? null));
  const [reason, setReason] = useState(settings.window?.reason ?? '');
  const [announce, setAnnounce] = useState(true);
  useReportUnsaved(
    startsAt !== toLocalInput(settings.window?.startsAt ?? null) ||
      endsAt !== toLocalInput(settings.window?.endsAt ?? null) ||
      reason !== (settings.window?.reason ?? ''),
  );
  const start = fromLocalInput(startsAt);
  const end = fromLocalInput(endsAt);
  const valid = Boolean(start && end && end > start);
  // Why Schedule is unavailable, beside it rather than a silently disabled button (#81).
  const problem =
    !start || !end
      ? 'Choose when the window starts and ends.'
      : end <= start
        ? 'The end must be after the start.'
        : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!start || !end) return;
    save.mutate({
      window: { startsAt: start, endsAt: end, reason: reason.trim() || null, announce },
    });
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 border-t border-[var(--border-subtle)] pt-5"
    >
      <div>
        <p className="font-medium text-sm">Scheduled window</p>
        <p className="text-[var(--text-muted)] text-xs">
          Read-only from the start until the end, without anyone at the switch. The announcement is
          shown to everyone from now until the window starts.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Starts" htmlFor={`${id}-start`}>
          <Input
            id={`${id}-start`}
            type="datetime-local"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
          />
        </Field>
        <Field label="Ends" htmlFor={`${id}-end`}>
          <Input
            id={`${id}-end`}
            type="datetime-local"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
          />
        </Field>
        <Field label="Reason" htmlFor={`${id}-window-reason`}>
          <Input
            id={`${id}-window-reason`}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            checked={announce}
            onChange={(event) => setAnnounce(event.target.checked)}
          />
          Announce it now
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="secondary"
          disabled={!valid || save.isPending}
          aria-describedby={problem ? `${id}-window-problem` : undefined}
        >
          {settings.window ? 'Update window' : 'Schedule window'}
        </Button>
        {settings.window && (
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => save.mutate({ window: null })}
          >
            Cancel window
          </Button>
        )}
        {problem && (
          <p id={`${id}-window-problem`} className="text-[var(--text-muted)] text-xs">
            {problem}
          </p>
        )}
      </div>
    </form>
  );
}

function Jobs({
  settings,
  save,
  editable,
}: {
  settings: MaintenanceSettings;
  save: Save;
  editable: boolean;
}) {
  const [keep, setKeep] = useState(
    () => new Set(settings.jobs.filter((job) => job.keepsRunning).map((job) => job.name)),
  );
  const changed = settings.jobs.some((job) => job.keepsRunning !== keep.has(job.name)) && editable;
  useReportUnsaved(changed);

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-5">
      <div>
        <p className="font-medium text-sm">Background jobs while read-only</p>
        <p className="text-[var(--text-muted)] text-xs">
          Jobs that write pause while read-only, apart from those ticked here. A job running when
          read-only starts stops after the batch in hand.
        </p>
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {settings.jobs.map((job) => (
          <li key={job.name}>
            <label className="flex items-center gap-2 font-mono text-xs">
              <input
                type="checkbox"
                disabled={!editable}
                checked={keep.has(job.name)}
                onChange={(event) => {
                  const next = new Set(keep);
                  if (event.target.checked) next.add(job.name);
                  else next.delete(job.name);
                  setKeep(next);
                }}
              />
              {job.name}
              {job.defaultKeepsRunning && (
                <span className="font-sans text-[var(--text-muted)]">(default)</span>
              )}
            </label>
          </li>
        ))}
      </ul>
      {editable && (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={!changed || save.isPending}
            onClick={() => save.mutate({ keepRunningJobs: [...keep] })}
          >
            Save jobs
          </Button>
        </div>
      )}
    </div>
  );
}
