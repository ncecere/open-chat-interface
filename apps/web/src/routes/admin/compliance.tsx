import type {
  BackupDestination,
  ComplianceRun,
  ComplianceSchedule,
  ComplianceStatus,
  LegalHold,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleAlert, CircleCheck, FileLock, Play, Scale, TriangleAlert } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  EmptyState,
  LoadError,
  MutationError,
  Notice,
  SaveRow,
  SettingsSection,
  ToggleSetting,
} from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { ADMIN_USERS_QUERY_KEY } from '~/components/admin/user-role-select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';
import { cn, formatRelativeTime } from '~/lib/utils';
import { formatBytes } from '~/routes/admin/lifecycle-shared';

export const COMPLIANCE_QUERY_KEY = ['admin', 'compliance'] as const;

const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${String(hour).padStart(2, '0')}:00 UTC`,
}));

const SCHEDULES: Array<{ value: ComplianceSchedule; label: string }> = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Once a day' },
];

const DESTINATIONS: Array<{ value: BackupDestination; label: string }> = [
  { value: 'storage', label: 'Attachment storage bucket' },
  { value: 'separate', label: 'Separate S3 bucket (recommended)' },
];

interface Draft {
  enabled: boolean;
  schedule: ComplianceSchedule;
  hourUtc: number;
  destination: BackupDestination;
  prefix: string;
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  secretAccessKey: string;
  includeContent: boolean;
  /** Empty keeps exported objects. */
  keepDays: string;
}

function draftFrom(status: ComplianceStatus): Draft {
  const { settings } = status;
  return {
    enabled: settings.enabled,
    schedule: settings.schedule,
    hourUtc: settings.hourUtc,
    destination: settings.destination,
    prefix: settings.prefix,
    bucket: settings.s3.bucket,
    region: settings.s3.region,
    endpoint: settings.s3.endpoint ?? '',
    accessKeyId: settings.s3.accessKeyId,
    forcePathStyle: settings.s3.forcePathStyle,
    secretAccessKey: '',
    includeContent: settings.includeContent,
    keepDays: settings.keepDays === null ? '' : String(settings.keepDays),
  };
}

/** Only what changed; the secret only when a new one was typed. Exported for tests. */
export function complianceChanges(status: ComplianceStatus, draft: Draft): Record<string, unknown> {
  const { settings } = status;
  const patch: Record<string, unknown> = {};
  if (draft.enabled !== settings.enabled) patch.enabled = draft.enabled;
  if (draft.schedule !== settings.schedule) patch.schedule = draft.schedule;
  if (draft.hourUtc !== settings.hourUtc) patch.hourUtc = draft.hourUtc;
  if (draft.destination !== settings.destination) patch.destination = draft.destination;
  if (draft.prefix.trim() !== settings.prefix) patch.prefix = draft.prefix.trim();
  if (draft.includeContent !== settings.includeContent) patch.includeContent = draft.includeContent;
  const keepDays = draft.keepDays.trim() ? Number(draft.keepDays) : null;
  if (keepDays !== settings.keepDays) patch.keepDays = keepDays;
  const s3: Record<string, unknown> = {};
  if (draft.bucket.trim() !== settings.s3.bucket) s3.bucket = draft.bucket.trim();
  if (draft.region.trim() !== settings.s3.region) s3.region = draft.region.trim();
  if ((draft.endpoint.trim() || null) !== settings.s3.endpoint)
    s3.endpoint = draft.endpoint.trim() || null;
  if (draft.accessKeyId.trim() !== settings.s3.accessKeyId)
    s3.accessKeyId = draft.accessKeyId.trim();
  if (draft.forcePathStyle !== settings.s3.forcePathStyle) s3.forcePathStyle = draft.forcePathStyle;
  if (draft.secretAccessKey) s3.secretAccessKey = draft.secretAccessKey;
  if (Object.keys(s3).length > 0) patch.s3 = s3;
  return patch;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function scheduleLabel(status: ComplianceStatus): string {
  const { settings } = status;
  if (!settings.enabled) return 'Off';
  return settings.schedule === 'hourly'
    ? 'Every hour'
    : `Daily at ${String(settings.hourUtc).padStart(2, '0')}:00 UTC`;
}

function RunIcon({ run }: { run: ComplianceRun }) {
  const Icon =
    run.status === 'failed' ? CircleAlert : run.status === 'running' ? TriangleAlert : CircleCheck;
  return (
    <Icon
      role="img"
      aria-label={
        run.status === 'failed' ? 'Failed' : run.status === 'running' ? 'Running' : 'Succeeded'
      }
      className={cn(
        'mt-0.5 size-4 shrink-0',
        run.status === 'failed'
          ? 'text-[var(--danger)]'
          : run.status === 'running'
            ? 'text-[var(--warning)]'
            : 'text-[var(--success)]',
      )}
    />
  );
}

function Overview({ status }: { status: ComplianceStatus }) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.post<{ started: boolean }>('/admin/compliance/run'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: COMPLIANCE_QUERY_KEY }),
  });
  const latest = status.runs[0];
  const held = status.holds.filter((hold) => !hold.liftedAt).length;

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Scheduled export</dt>
          <dd className="mt-1 font-semibold">{scheduleLabel(status)}</dd>
          {status.nextRunAt && (
            <dd className="text-xs text-[var(--text-muted)]">Next {when(status.nextRunAt)}</dd>
          )}
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Last successful export</dt>
          <dd className="mt-1 font-semibold">
            {status.lastSuccessAt ? formatRelativeTime(status.lastSuccessAt) : 'None yet'}
          </dd>
          <dd className="text-xs text-[var(--text-muted)]">
            {status.settings.includeContent
              ? 'Audit events and conversation content'
              : 'Audit events only'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">People on legal hold</dt>
          <dd className="mt-1 font-semibold">{held}</dd>
          <dd className="text-xs text-[var(--text-muted)]">
            Audit events exported through #{status.cursor.audit}
          </dd>
        </div>
      </dl>

      {status.issues.length > 0 && (
        <Notice tone="warning" title="The export cannot run yet">
          <ul className="list-disc pl-4">
            {status.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Notice>
      )}
      {latest?.status === 'failed' && (
        <Notice tone="warning" title="The latest export failed">
          {latest.errorMessage ?? 'No reason was recorded.'} Nothing was skipped: the next run
          starts where the last successful one ended.
        </Notice>
      )}

      <EditOnly>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={run.isPending || status.running || status.issues.length > 0}
            onClick={() => run.mutate()}
          >
            {run.isPending ? <Spinner /> : <Play />}
            Export now
          </Button>
          <p aria-live="polite" className="text-sm text-[var(--text-muted)]">
            {status.running
              ? 'An export is running. This page updates when it finishes.'
              : run.isSuccess
                ? 'Export started.'
                : ''}
          </p>
        </div>
      </EditOnly>
      <MutationError error={run.error} message="The export could not be started." />
    </div>
  );
}

function SettingsForm({
  status,
  saved,
  setSaved,
}: {
  status: ComplianceStatus;
  saved: boolean;
  setSaved: (saved: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(status));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<ComplianceStatus>('/admin/compliance/settings', patch),
    onSuccess: async (next) => {
      queryClient.setQueryData(COMPLIANCE_QUERY_KEY, next);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; detail: string }>('/admin/compliance/test'),
  });

  const patch = complianceChanges(status, draft);
  const hasChanges = Object.keys(patch).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (hasChanges) save.mutate(patch);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <ToggleSetting
        id="compliance-enabled"
        label="Export automatically"
        description="Writes every audit event as JSON Lines to S3-compatible storage, with a checksummed manifest per run. Each run continues exactly where the last one ended."
        checked={draft.enabled}
        disabled={false}
        onCheckedChange={(enabled) => set('enabled', enabled)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="How often" htmlFor="compliance-schedule">
          <Select
            id="compliance-schedule"
            value={draft.schedule}
            onChange={(value) => set('schedule', value as ComplianceSchedule)}
            options={SCHEDULES}
          />
        </Field>
        {draft.schedule === 'daily' && (
          <Field
            label="Time of day"
            htmlFor="compliance-hour"
            hint="The daily export starts within a few minutes of this hour."
          >
            <Select
              id="compliance-hour"
              value={String(draft.hourUtc)}
              onChange={(value) => set('hourUtc', Number(value))}
              options={HOURS}
            />
          </Field>
        )}
      </div>

      <ToggleSetting
        id="compliance-content"
        label="Include conversation content"
        description="Also export the text of every message people send and receive, with tool steps summarised and attached files named. Attachment contents are never exported."
        checked={draft.includeContent}
        disabled={false}
        onCheckedChange={(includeContent) => set('includeContent', includeContent)}
      />
      {draft.includeContent && (
        <Notice tone="warning" title="Conversation content leaves OCI">
          Everyone’s messages, including temporary chats, are copied to the destination, where OCI’s
          retention, deletion and access controls no longer apply. Turn this on only where your
          policy requires it and people have been told. Content is exported from the moment you
          save; earlier conversations are not.
        </Notice>
      )}

      <Field
        label="Destination"
        htmlFor="compliance-destination"
        hint={
          draft.destination === 'storage'
            ? `Written to ${status.attachmentStorage.bucket ? `the ${status.attachmentStorage.bucket} bucket` : 'the attachment bucket'} under .oci-compliance/.`
            : 'Its own bucket and credentials. Recommended: give it object lock or versioning so records cannot be altered.'
        }
      >
        <Select
          id="compliance-destination"
          value={draft.destination}
          onChange={(value) => set('destination', value as BackupDestination)}
          options={DESTINATIONS}
        />
      </Field>

      {draft.destination === 'separate' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bucket" htmlFor="compliance-bucket">
            <Input
              id="compliance-bucket"
              value={draft.bucket}
              onChange={(e) => set('bucket', e.target.value)}
            />
          </Field>
          <Field label="Region" htmlFor="compliance-region">
            <Input
              id="compliance-region"
              value={draft.region}
              onChange={(e) => set('region', e.target.value)}
            />
          </Field>
          <Field
            label="Endpoint (optional)"
            htmlFor="compliance-endpoint"
            hint="For MinIO and other S3-compatible services."
          >
            <Input
              id="compliance-endpoint"
              value={draft.endpoint}
              placeholder="https://s3.example.com"
              onChange={(e) => set('endpoint', e.target.value)}
            />
          </Field>
          <Field
            label="Key prefix"
            htmlFor="compliance-prefix"
            hint="Folder for exports, ending with /."
          >
            <Input
              id="compliance-prefix"
              value={draft.prefix}
              onChange={(e) => set('prefix', e.target.value)}
            />
          </Field>
          <Field label="Access key ID" htmlFor="compliance-access-key">
            <Input
              id="compliance-access-key"
              value={draft.accessKeyId}
              autoComplete="off"
              onChange={(e) => set('accessKeyId', e.target.value)}
            />
          </Field>
          <Field
            label="Secret access key"
            htmlFor="compliance-secret"
            hint={
              status.settings.s3.hasCredential
                ? 'Set. Leave empty to keep it; stored encrypted and never shown again.'
                : 'Not set. Stored encrypted and never shown again.'
            }
          >
            <Input
              id="compliance-secret"
              type="password"
              autoComplete="off"
              value={draft.secretAccessKey}
              onChange={(e) => set('secretAccessKey', e.target.value)}
            />
          </Field>
          <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3 sm:col-span-2">
            <label htmlFor="compliance-path-style" className="text-sm font-medium">
              Path-style addressing (MinIO and most self-hosted services)
            </label>
            <Switch
              id="compliance-path-style"
              checked={draft.forcePathStyle}
              onCheckedChange={(value) => set('forcePathStyle', value)}
            />
          </div>
        </div>
      )}

      <Field
        label="Delete exported objects after (days)"
        htmlFor="compliance-keep-days"
        hint="Leave empty to keep them, the default: institutions usually manage these records themselves. Deleting old objects never exports their events again."
      >
        <Input
          id="compliance-keep-days"
          type="number"
          min={1}
          max={3650}
          placeholder="Keep"
          value={draft.keepDays}
          onChange={(e) => set('keepDays', e.target.value)}
        />
      </Field>

      <EditOnly>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={test.isPending || hasChanges}
            onClick={() => test.mutate()}
          >
            {test.isPending && <Spinner />}
            Test destination
          </Button>
          <p aria-live="polite" className="text-sm">
            {hasChanges ? (
              <span className="text-[var(--text-muted)]">Save first to test these settings.</span>
            ) : test.data ? (
              <span className={test.data.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                {test.data.detail}
              </span>
            ) : null}
          </p>
        </div>
      </EditOnly>
      <MutationError error={test.error} message="The destination could not be tested." />

      <SaveRow
        hasChanges={hasChanges}
        isPending={save.isPending}
        errorMessage={
          save.error
            ? save.error instanceof ApiError
              ? save.error.message
              : 'Compliance settings could not be saved.'
            : null
        }
        successMessage={saved && !hasChanges ? 'Compliance settings saved.' : null}
      />
    </form>
  );
}

function PlaceHoldForm() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const place = useMutation({
    mutationFn: () =>
      api.post<{ hold: LegalHold }>('/admin/compliance/holds', {
        email: email.trim(),
        reason: reason.trim(),
      }),
    onSuccess: async () => {
      setEmail('');
      setReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: COMPLIANCE_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY }),
      ]);
    },
  });

  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (email.trim() && reason.trim()) place.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Person’s email address" htmlFor="hold-email">
          <Input
            id="hold-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          label="Reason"
          htmlFor="hold-reason"
          hint="A matter or case reference. Recorded in the audit log."
        >
          <Input
            id="hold-reason"
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={place.isPending || !email.trim() || !reason.trim()}>
          {place.isPending ? <Spinner /> : <FileLock />}
          Place hold
        </Button>
      </div>
      <MutationError error={place.error} message="The hold could not be placed." />
    </form>
  );
}

function HoldList({ holds }: { holds: LegalHold[] }) {
  const queryClient = useQueryClient();
  const [lifting, setLifting] = useState<LegalHold | null>(null);
  const [liftReason, setLiftReason] = useState('');
  const active = holds.filter((hold) => !hold.liftedAt);
  const lifted = holds.filter((hold) => hold.liftedAt);

  async function lift() {
    if (!lifting) return;
    await api.post(`/admin/compliance/holds/${lifting.id}/lift`, {
      ...(liftReason.trim() ? { reason: liftReason.trim() } : {}),
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: COMPLIANCE_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY }),
    ]);
  }

  return (
    <div className="flex flex-col gap-4">
      {active.length === 0 ? (
        <EmptyState icon={Scale} title="Nobody is on legal hold.">
          A hold keeps everything a person has from retention, trash purging, temporary chat expiry
          and account deletion until it is lifted.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
          {active.map((hold) => (
            <li key={hold.id} className="flex items-start gap-3 px-4 py-3" data-testid="legal-hold">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/admin/users/$userId"
                    params={{ userId: hold.userId }}
                    className="text-sm font-medium hover:underline"
                  >
                    {hold.userName || hold.userEmail}
                  </Link>
                  <Badge variant="warning">Legal hold</Badge>
                </div>
                <p className="text-xs text-[var(--text-muted)]">
                  {hold.userEmail} · {hold.reason}
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  Placed {when(hold.placedAt)}
                  {hold.placedByEmail ? ` by ${hold.placedByEmail}` : ''}
                </p>
              </div>
              <EditOnly>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setLiftReason('');
                    setLifting(hold);
                  }}
                >
                  Lift
                </Button>
              </EditOnly>
            </li>
          ))}
        </ul>
      )}
      {lifted.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--text-muted)]">
            {lifted.length} lifted {lifted.length === 1 ? 'hold' : 'holds'}
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            {lifted.map((hold) => (
              <li key={hold.id}>
                {hold.userEmail}: {hold.reason} · placed {when(hold.placedAt)}, lifted{' '}
                {when(hold.liftedAt)}
                {hold.liftedByEmail ? ` by ${hold.liftedByEmail}` : ''}
                {hold.liftReason ? ` (${hold.liftReason})` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ConfirmDialog
        open={lifting !== null}
        onOpenChange={(open) => !open && setLifting(null)}
        title={`Lift the hold on ${lifting?.userName || lifting?.userEmail || 'this person'}?`}
        description="Retention, trash purging, temporary chat expiry and account deletion apply to their data again from now on."
        confirmLabel="Lift hold"
        pendingLabel="Lifting…"
        errorMessage="The hold could not be lifted."
        onConfirm={lift}
      >
        <Field label="Reason (optional)" htmlFor="lift-reason" hint="Recorded in the audit log.">
          <Input
            id="lift-reason"
            value={liftReason}
            maxLength={1000}
            onChange={(event) => setLiftReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>
    </div>
  );
}

function History({ runs }: { runs: ComplianceRun[] }) {
  if (runs.length === 0)
    return (
      <EmptyState icon={FileLock} title="No exports yet.">
        Turn on the export or export now. Each run is verified by reading its objects back.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
      {runs.map((run) => (
        <li key={run.id} className="flex items-start gap-3 px-4 py-3" data-testid="compliance-run">
          <RunIcon run={run} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{when(run.startedAt)}</p>
              <Badge variant="neutral">{run.trigger === 'manual' ? 'Manual' : 'Scheduled'}</Badge>
              {run.status === 'succeeded' && run.manifestKey && (
                <Badge variant="success">Verified</Badge>
              )}
              {run.prunedAt && <Badge variant="outline">Deleted</Badge>}
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              {run.status === 'succeeded'
                ? run.manifestKey
                  ? `${run.audit.count ?? 0} audit events${run.messages ? ` · ${run.messages.count ?? 0} messages` : ''} · ${formatBytes((run.audit.bytes ?? 0) + (run.messages?.bytes ?? 0))}`
                  : 'Nothing new to export.'
                : run.status === 'running'
                  ? 'Running…'
                  : (run.errorMessage ?? 'Failed')}
            </p>
            {run.manifestKey && run.status === 'succeeded' && !run.prunedAt && (
              <p className="truncate font-mono text-xs text-[var(--text-muted)]">
                {run.manifestKey}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Data & storage → Compliance: audit events (and, when turned on,
 * conversation content) exported to S3-compatible storage, and legal holds.
 */
export function AdminCompliancePage() {
  const [saved, setSaved] = useState(false);
  const status = useQuery({
    queryKey: COMPLIANCE_QUERY_KEY,
    queryFn: () => api.get<ComplianceStatus>('/admin/compliance'),
    refetchInterval: (query) => (query.state.data?.running ? 5_000 : false),
  });

  return (
    <div>
      <AdminPageHeader
        title="Compliance"
        description="An export of audit events, and optionally conversation content, as JSON Lines to S3-compatible storage for eDiscovery, records requests and security monitoring; and legal holds that keep named people’s data from being deleted."
      />
      {status.isLoading ? (
        <div className="py-8" role="status" aria-label="Loading compliance">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : status.isError || !status.data ? (
        <LoadError title="Compliance could not be loaded." query={status} />
      ) : (
        <div className="flex flex-col gap-10 pb-10">
          <SettingsSection
            editable={false}
            title="Status"
            description="What is scheduled, the last good export and who is on hold."
          >
            <Overview status={status.data} />
          </SettingsSection>
          <SettingsSection
            title="Export settings"
            description="What is exported, where and how often. Every run writes a folder with its objects and a manifest of their counts and checksums."
          >
            <SettingsForm
              key={JSON.stringify(status.data.settings)}
              status={status.data}
              saved={saved}
              setSaved={setSaved}
            />
          </SettingsSection>
          <SettingsSection
            title="Legal holds"
            description="While a person is on hold, retention, trash purging, temporary chat expiry and account deletion skip their data. Placing and lifting holds is audited."
          >
            <div className="flex flex-col gap-6">
              <EditOnly>
                <PlaceHoldForm />
              </EditOnly>
              <HoldList holds={status.data.holds} />
            </div>
          </SettingsSection>
          <SettingsSection
            editable={false}
            title="History"
            description="The last 20 runs. A failed run moves nothing on: the next one exports the same events."
          >
            <History runs={status.data.runs} />
          </SettingsSection>
        </div>
      )}
    </div>
  );
}
