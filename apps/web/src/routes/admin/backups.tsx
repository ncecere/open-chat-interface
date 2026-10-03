import {
  BACKUP_FILE_SAMPLE_SIZE,
  type BackupFileVerification,
  type BackupRun,
  type BackupStatus,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  AdminPageHeader,
  LoadError,
  Notice,
  SaveRow,
  SettingsSection,
  ToggleSetting,
} from '~/components/admin/admin-ui';
import {
  type DestinationDraft,
  DestinationSelect,
  DestinationTest,
  destinationChanges,
  destinationDraftFrom,
  S3BucketFields,
} from '~/components/admin/operations/destination';
import { formatRunTime, RunHistory, RunNowControl } from '~/components/admin/operations/runs';
import { formatHourUtc, HourField, RetentionField } from '~/components/admin/operations/schedule';
import { Badge } from '~/components/ui/badge';
import { Field } from '~/components/ui/field';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';
import { formatBytes } from '~/routes/admin/lifecycle-shared';

export const BACKUPS_QUERY_KEY = ['admin', 'backups'] as const;

const VERIFICATION: Array<{ value: BackupFileVerification; label: string }> = [
  { value: 'sample', label: `A random sample (${BACKUP_FILE_SAMPLE_SIZE} files)` },
  { value: 'all', label: 'Every file' },
];

interface Draft extends DestinationDraft {
  enabled: boolean;
  hourUtc: number;
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
    ...destinationDraftFrom(settings),
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
  Object.assign(patch, destinationChanges(settings, draft));
  const keepDaily = Number(draft.keepDaily);
  const keepWeekly = Number(draft.keepWeekly);
  if (keepDaily !== settings.keepDaily) patch.keepDaily = keepDaily;
  if (keepWeekly !== settings.keepWeekly) patch.keepWeekly = keepWeekly;
  if (draft.copyFiles !== settings.copyFiles) patch.copyFiles = draft.copyFiles;
  if (draft.verifyFiles !== settings.verifyFiles) patch.verifyFiles = draft.verifyFiles;
  return patch;
}

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

function Overview({ status }: { status: BackupStatus }) {
  const latest = status.runs[0];

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-[var(--text-muted)]">Scheduled backups</dt>
          <dd className="mt-1 font-semibold">
            {status.settings.enabled ? `Daily at ${formatHourUtc(status.settings.hourUtc)}` : 'Off'}
          </dd>
          {status.nextRunAt && (
            <dd className="text-xs text-[var(--text-muted)]">
              Next {formatRunTime(status.nextRunAt)}
            </dd>
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

      <RunNowControl
        endpoint="/admin/backups/run"
        queryKey={BACKUPS_QUERY_KEY}
        label="Back up now"
        running={status.running}
        blocked={status.issues.length > 0}
        runningText="A backup is running. This page updates when it finishes."
        startedText="Backup started."
        errorMessage="The backup could not be started."
      />
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
        <HourField
          id="backups-hour"
          hint="The daily backup starts within ten minutes of this hour."
          value={draft.hourUtc}
          onChange={(hour) => set('hourUtc', hour)}
        />
        <DestinationSelect
          idPrefix="backups"
          value={draft.destination}
          onChange={(destination) => set('destination', destination)}
          hint={
            draft.destination === 'storage'
              ? `Written to ${status.attachmentStorage.bucket ? `the ${status.attachmentStorage.bucket} bucket` : 'the attachment bucket'} under .oci-backups/. One credential then protects both the data and its backups.`
              : 'Its own bucket and credentials, so losing the attachment bucket does not also lose the backups.'
          }
        />
      </div>

      {draft.destination === 'separate' && (
        <S3BucketFields
          idPrefix="backups"
          draft={draft}
          onChange={(change) => {
            setSaved(false);
            setDraft((current) => ({ ...current, ...change }));
          }}
          hasCredential={status.settings.s3.hasCredential}
          prefixHint="Folder for backups, ending with /."
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <RetentionField
          id="backups-keep-daily"
          label="Daily backups kept"
          hint="The newest backup of each of this many days (1–90)."
          min={1}
          max={90}
          value={draft.keepDaily}
          onChange={(value) => set('keepDaily', value)}
        />
        <RetentionField
          id="backups-keep-weekly"
          label="Weekly backups kept"
          hint="The newest backup of each of this many weeks (0–104)."
          min={0}
          max={104}
          value={draft.keepWeekly}
          onChange={(value) => set('keepWeekly', value)}
        />
      </div>

      <DestinationTest endpoint="/admin/backups/test" hasChanges={hasChanges} />

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
  return (
    <RunHistory
      runs={runs}
      testId="backup-run"
      empty={{
        icon: DatabaseBackup,
        title: 'No backups yet.',
        body: 'Turn on automatic backups or back up now. Each run is verified by reading the archive back.',
      }}
      badges={(run) => (
        <>
          {run.verified && <Badge variant="success">Verified</Badge>}
          {run.prunedAt && run.status === 'succeeded' && <Badge variant="outline">Expired</Badge>}
          {(run.missingObjects ?? 0) > 0 && (
            <Badge variant="warning">{run.missingObjects} missing objects</Badge>
          )}
        </>
      )}
      summary={(run) =>
        `${formatBytes(run.dumpBytes ?? 0)} database · ${run.attachmentCount ?? 0} attachment objects (${formatBytes(run.attachmentBytes ?? 0)})${run.verificationDetail ? ` · ${run.verificationDetail}` : ''}`
      }
      details={(run) =>
        run.files &&
        run.status === 'succeeded' && (
          <p className="text-xs text-[var(--text-muted)]" data-testid="backup-run-files">
            {filesSummary(run.files)}
          </p>
        )
      }
      objectKey={(run) =>
        run.dumpKey && run.status === 'succeeded' && !run.prunedAt ? run.dumpKey : null
      }
    />
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
