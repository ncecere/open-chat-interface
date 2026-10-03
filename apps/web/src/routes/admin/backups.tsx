import {
  BACKUP_FILE_SAMPLE_SIZE,
  type BackupDestination,
  type BackupFileVerification,
  type BackupRun,
  type BackupStatus,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, DatabaseBackup, Play, TriangleAlert } from 'lucide-react';
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

export const BACKUPS_QUERY_KEY = ['admin', 'backups'] as const;

const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${String(hour).padStart(2, '0')}:00 UTC`,
}));

const DESTINATIONS: Array<{ value: BackupDestination; label: string }> = [
  { value: 'storage', label: 'Attachment storage bucket' },
  { value: 'separate', label: 'Separate S3 bucket (recommended)' },
];

const VERIFICATION: Array<{ value: BackupFileVerification; label: string }> = [
  { value: 'sample', label: `A random sample (${BACKUP_FILE_SAMPLE_SIZE} files)` },
  { value: 'all', label: 'Every file' },
];

interface Draft {
  enabled: boolean;
  hourUtc: number;
  destination: BackupDestination;
  prefix: string;
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  secretAccessKey: string;
  keepDaily: string;
  keepWeekly: string;
  copyFiles: boolean;
  verifyFiles: BackupFileVerification;
}

function draftFrom(status: BackupStatus): Draft {
  const { settings } = status;
  return {
    enabled: settings.enabled,
    hourUtc: settings.hourUtc,
    destination: settings.destination,
    prefix: settings.prefix,
    bucket: settings.s3.bucket,
    region: settings.s3.region,
    endpoint: settings.s3.endpoint ?? '',
    accessKeyId: settings.s3.accessKeyId,
    forcePathStyle: settings.s3.forcePathStyle,
    secretAccessKey: '',
    keepDaily: String(settings.keepDaily),
    keepWeekly: String(settings.keepWeekly),
    copyFiles: settings.copyFiles,
    verifyFiles: settings.verifyFiles,
  };
}

/** Only what changed; the secret only when a new one was typed. Exported for tests. */
export function backupChanges(status: BackupStatus, draft: Draft): Record<string, unknown> {
  const { settings } = status;
  const patch: Record<string, unknown> = {};
  if (draft.enabled !== settings.enabled) patch.enabled = draft.enabled;
  if (draft.hourUtc !== settings.hourUtc) patch.hourUtc = draft.hourUtc;
  if (draft.destination !== settings.destination) patch.destination = draft.destination;
  if (draft.prefix.trim() !== settings.prefix) patch.prefix = draft.prefix.trim();
  const keepDaily = Number(draft.keepDaily);
  const keepWeekly = Number(draft.keepWeekly);
  if (keepDaily !== settings.keepDaily) patch.keepDaily = keepDaily;
  if (keepWeekly !== settings.keepWeekly) patch.keepWeekly = keepWeekly;
  if (draft.copyFiles !== settings.copyFiles) patch.copyFiles = draft.copyFiles;
  if (draft.verifyFiles !== settings.verifyFiles) patch.verifyFiles = draft.verifyFiles;
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

/** What a run did with attachment files, for the history. Exported for tests. */
export function filesSummary(files: NonNullable<BackupRun['files']>): string {
  const parts = [
    `${files.copiedObjects} files copied (${formatBytes(files.copiedBytes)})`,
    `${files.skippedObjects} already backed up (${formatBytes(files.skippedBytes)})`,
    `${files.verifiedObjects} read back`,
  ];
  if (files.sweptObjects) parts.push(`${files.sweptObjects} unused copies deleted`);
  return parts.join(' · ');
}

function RunIcon({ run }: { run: BackupRun }) {
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

function Overview({ status }: { status: BackupStatus }) {
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => api.post<{ started: boolean }>('/admin/backups/run'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BACKUPS_QUERY_KEY }),
  });
  const latest = status.runs[0];

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Scheduled backups</dt>
          <dd className="mt-1 font-semibold">
            {status.settings.enabled
              ? `Daily at ${String(status.settings.hourUtc).padStart(2, '0')}:00 UTC`
              : 'Off'}
          </dd>
          {status.nextRunAt && (
            <dd className="text-xs text-[var(--text-muted)]">Next {when(status.nextRunAt)}</dd>
          )}
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Last successful backup</dt>
          <dd className="mt-1 font-semibold">
            {status.lastSuccessAt ? formatRelativeTime(status.lastSuccessAt) : 'None yet'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[var(--text-muted)]">PostgreSQL client tools</dt>
          <dd className="mt-1 font-semibold">{status.pgDumpVersion ?? 'Not found'}</dd>
        </div>
      </dl>

      {status.issues.length > 0 && (
        <Notice tone="warning" title="Backups cannot run yet">
          <ul className="list-disc pl-4">
            {status.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Notice>
      )}
      {!status.settings.copyFiles && (
        <Notice tone="info" title="Attachment files are not copied">
          Backups list every attachment with its checksum but do not copy the files, so a backup
          alone cannot restore attachments. Turn on <em>Copy attachment files</em> below, or protect
          attachment storage separately.
        </Notice>
      )}
      {latest?.status === 'failed' && (
        <Notice tone="warning" title="The latest backup failed">
          {latest.errorMessage ?? 'No reason was recorded.'}
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
            Back up now
          </Button>
          <p aria-live="polite" className="text-sm text-[var(--text-muted)]">
            {status.running
              ? 'A backup is running. This page updates when it finishes.'
              : run.isSuccess
                ? 'Backup started.'
                : ''}
          </p>
        </div>
      </EditOnly>
      <MutationError error={run.error} message="The backup could not be started." />
    </div>
  );
}

function SettingsForm({
  status,
  saved,
  setSaved,
}: {
  status: BackupStatus;
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
      api.patch<BackupStatus>('/admin/backups/settings', patch),
    onSuccess: async (next) => {
      queryClient.setQueryData(BACKUPS_QUERY_KEY, next);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; detail: string }>('/admin/backups/test'),
  });

  const patch = backupChanges(status, draft);
  const hasChanges = Object.keys(patch).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (hasChanges) save.mutate(patch);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <ToggleSetting
        id="backups-enabled"
        label="Back up automatically"
        description="Runs pg_dump once a day and writes the archive, with a manifest of attachment objects, to S3-compatible storage. Leave off if this instance is backed up another way."
        checked={draft.enabled}
        disabled={false}
        onCheckedChange={(enabled) => set('enabled', enabled)}
      />
      <ToggleSetting
        id="backups-copy-files"
        label="Copy attachment files"
        description={`Copies every attachment file to the destination, stored once by content: the first backup copies everything (as much storage again as attachments use now${status.attachmentStorage.driver === 's3' ? ', billed by your S3 provider' : ''}), later ones only new files. Copies no kept backup needs are deleted after retention.`}
        checked={draft.copyFiles}
        disabled={false}
        onCheckedChange={(copyFiles) => set('copyFiles', copyFiles)}
      />
      {draft.copyFiles && (
        <Field
          label="Files checked after each backup"
          htmlFor="backups-verify-files"
          hint="Read back from the destination and checksummed. Checking every file reads all of them on every run."
        >
          <Select
            id="backups-verify-files"
            value={draft.verifyFiles}
            onChange={(value) => set('verifyFiles', value as BackupFileVerification)}
            options={VERIFICATION}
          />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Time of day"
          htmlFor="backups-hour"
          hint="The daily backup starts within ten minutes of this hour."
        >
          <Select
            id="backups-hour"
            value={String(draft.hourUtc)}
            onChange={(value) => set('hourUtc', Number(value))}
            options={HOURS}
          />
        </Field>
        <Field
          label="Destination"
          htmlFor="backups-destination"
          hint={
            draft.destination === 'storage'
              ? `Written to ${status.attachmentStorage.bucket ? `the ${status.attachmentStorage.bucket} bucket` : 'the attachment bucket'} under .oci-backups/. One credential then protects both the data and its backups.`
              : 'Its own bucket and credentials, so losing the attachment bucket does not also lose the backups.'
          }
        >
          <Select
            id="backups-destination"
            value={draft.destination}
            onChange={(value) => set('destination', value as BackupDestination)}
            options={DESTINATIONS}
          />
        </Field>
      </div>

      {draft.destination === 'separate' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bucket" htmlFor="backups-bucket">
            <Input
              id="backups-bucket"
              value={draft.bucket}
              onChange={(e) => set('bucket', e.target.value)}
            />
          </Field>
          <Field label="Region" htmlFor="backups-region">
            <Input
              id="backups-region"
              value={draft.region}
              onChange={(e) => set('region', e.target.value)}
            />
          </Field>
          <Field
            label="Endpoint (optional)"
            htmlFor="backups-endpoint"
            hint="For MinIO and other S3-compatible services."
          >
            <Input
              id="backups-endpoint"
              value={draft.endpoint}
              placeholder="https://s3.example.com"
              onChange={(e) => set('endpoint', e.target.value)}
            />
          </Field>
          <Field
            label="Key prefix"
            htmlFor="backups-prefix"
            hint="Folder for backups, ending with /."
          >
            <Input
              id="backups-prefix"
              value={draft.prefix}
              onChange={(e) => set('prefix', e.target.value)}
            />
          </Field>
          <Field label="Access key ID" htmlFor="backups-access-key">
            <Input
              id="backups-access-key"
              value={draft.accessKeyId}
              autoComplete="off"
              onChange={(e) => set('accessKeyId', e.target.value)}
            />
          </Field>
          <Field
            label="Secret access key"
            htmlFor="backups-secret"
            hint={
              status.settings.s3.hasCredential
                ? 'Set. Leave empty to keep it; stored encrypted and never shown again.'
                : 'Not set. Stored encrypted and never shown again.'
            }
          >
            <Input
              id="backups-secret"
              type="password"
              autoComplete="off"
              value={draft.secretAccessKey}
              onChange={(e) => set('secretAccessKey', e.target.value)}
            />
          </Field>
          <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3 sm:col-span-2">
            <label htmlFor="backups-path-style" className="text-sm font-medium">
              Path-style addressing (MinIO and most self-hosted services)
            </label>
            <Switch
              id="backups-path-style"
              checked={draft.forcePathStyle}
              onCheckedChange={(value) => set('forcePathStyle', value)}
            />
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Daily backups kept"
          htmlFor="backups-keep-daily"
          hint="The newest backup of each of this many days (1–90)."
        >
          <Input
            id="backups-keep-daily"
            type="number"
            min={1}
            max={90}
            value={draft.keepDaily}
            onChange={(e) => set('keepDaily', e.target.value)}
          />
        </Field>
        <Field
          label="Weekly backups kept"
          htmlFor="backups-keep-weekly"
          hint="The newest backup of each of this many weeks (0–104)."
        >
          <Input
            id="backups-keep-weekly"
            type="number"
            min={0}
            max={104}
            value={draft.keepWeekly}
            onChange={(e) => set('keepWeekly', e.target.value)}
          />
        </Field>
      </div>

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
              : 'Backup settings could not be saved.'
            : null
        }
        successMessage={saved && !hasChanges ? 'Backup settings saved.' : null}
      />
    </form>
  );
}

function History({ runs }: { runs: BackupRun[] }) {
  if (runs.length === 0)
    return (
      <EmptyState icon={DatabaseBackup} title="No backups yet.">
        Turn on automatic backups or back up now. Each run is verified by reading the archive back.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
      {runs.map((run) => (
        <li key={run.id} className="flex items-start gap-3 px-4 py-3" data-testid="backup-run">
          <RunIcon run={run} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{when(run.startedAt)}</p>
              <Badge variant="neutral">{run.trigger === 'manual' ? 'Manual' : 'Scheduled'}</Badge>
              {run.verified && <Badge variant="success">Verified</Badge>}
              {run.prunedAt && run.status === 'succeeded' && (
                <Badge variant="outline">Expired</Badge>
              )}
              {(run.missingObjects ?? 0) > 0 && (
                <Badge variant="warning">{run.missingObjects} missing objects</Badge>
              )}
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              {run.status === 'succeeded'
                ? `${formatBytes(run.dumpBytes ?? 0)} database · ${run.attachmentCount ?? 0} attachment objects (${formatBytes(run.attachmentBytes ?? 0)})${run.verificationDetail ? ` · ${run.verificationDetail}` : ''}`
                : run.status === 'running'
                  ? 'Running…'
                  : (run.errorMessage ?? 'Failed')}
            </p>
            {run.files && run.status === 'succeeded' && (
              <p className="text-xs text-[var(--text-muted)]" data-testid="backup-run-files">
                {filesSummary(run.files)}
              </p>
            )}
            {run.dumpKey && run.status === 'succeeded' && !run.prunedAt && (
              <p className="truncate font-mono text-xs text-[var(--text-muted)]">{run.dumpKey}</p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Data & storage → Backups: a daily pg_dump and attachment manifest written
 * to S3-compatible storage, verified after every run, with retention.
 */
export function AdminBackupsPage() {
  const [saved, setSaved] = useState(false);
  const status = useQuery({
    queryKey: BACKUPS_QUERY_KEY,
    queryFn: () => api.get<BackupStatus>('/admin/backups'),
    // Poll while a backup runs so its result appears without a reload.
    refetchInterval: (query) => (query.state.data?.running ? 5_000 : false),
  });

  return (
    <div>
      <AdminPageHeader
        title="Backups"
        description="A daily database dump, a checksummed manifest of attachment objects and, when turned on, copies of the files, written to S3-compatible storage and verified after every run. Restoring is a manual step, described in the administrator guide."
      />
      {status.isLoading ? (
        <div className="py-8" role="status" aria-label="Loading backups">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : status.isError || !status.data ? (
        <LoadError title="Backups could not be loaded." query={status} />
      ) : (
        <div className="flex flex-col gap-10 pb-10">
          <SettingsSection
            editable={false}
            title="Status"
            description="What is scheduled, and the last good backup."
          >
            <Overview status={status.data} />
          </SettingsSection>
          <SettingsSection
            title="Settings"
            description="Where backups go, when they run and how many are kept. Older backups are deleted after each successful run."
          >
            {/* Remounts with fresh fields only when the saved settings change, not on every poll. */}
            <SettingsForm
              key={JSON.stringify(status.data.settings)}
              status={status.data}
              saved={saved}
              setSaved={setSaved}
            />
          </SettingsSection>
          <SettingsSection
            editable={false}
            title="History"
            description="The last 20 runs, with what each copied. Without file copies, attachment objects are only listed with their checksums; see the guide for what that means for a restore."
          >
            <History runs={status.data.runs} />
          </SettingsSection>
        </div>
      )}
    </div>
  );
}
