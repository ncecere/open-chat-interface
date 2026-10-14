import {
  BACKUP_FILE_SAMPLE_SIZE,
  type BackupDatabaseMode,
  type BackupFileVerification,
  type BackupRun,
  type BackupStatus,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import {
  AdminPageHeader,
  LoadError,
  Notice,
  SaveRow,
  SettingsSection,
  ToggleSetting,
} from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import {
  type DestinationDraft,
  DestinationSelect,
  DestinationTest,
  destinationChanges,
  destinationDraftFrom,
  S3_BUCKET_FIELDS,
  S3BucketFields,
} from '~/components/admin/operations/destination';
import { formatRunTime, RunHistory, RunNowControl } from '~/components/admin/operations/runs';
import { formatHourUtc, HourField, RetentionField } from '~/components/admin/operations/schedule';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Badge } from '~/components/ui/badge';
import { Field } from '~/components/ui/field';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { api, apiErrorProblems } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';
import { formatBytes } from '~/routes/admin/lifecycle-shared';

export const BACKUPS_QUERY_KEY = ['admin', 'backups'] as const;

const VERIFICATION: Array<{ value: BackupFileVerification; label: string }> = [
  { value: 'sample', label: `A random sample (${BACKUP_FILE_SAMPLE_SIZE} files)` },
  { value: 'all', label: 'Every file' },
];

const DATABASE_MODES: Array<{ value: BackupDatabaseMode; label: string }> = [
  { value: 'dump', label: 'OCI dumps the database (pg_dump)' },
  { value: 'external', label: 'Backed up outside OCI (your own tooling)' },
];

/** Shown whenever the database is backed up outside OCI: what OCI does not know. */
const EXTERNAL_LIMIT = 'OCI cannot tell whether it restores.';

interface Draft extends DestinationDraft {
  enabled: boolean;
  hourUtc: number;
  keepDaily: string;
  keepWeekly: string;
  copyFiles: boolean;
  verifyFiles: BackupFileVerification;
  databaseBackup: BackupDatabaseMode;
  walArchivingExpected: boolean;
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
    databaseBackup: settings.databaseBackup,
    walArchivingExpected: settings.walArchivingExpected,
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
  if (draft.databaseBackup !== settings.databaseBackup) patch.databaseBackup = draft.databaseBackup;
  if (draft.walArchivingExpected !== settings.walArchivingExpected)
    patch.walArchivingExpected = draft.walArchivingExpected;
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
  const blockedId = useId();
  const external = status.settings.databaseBackup === 'external';

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
          <dd className="mt-1 font-semibold">
            {external ? 'Not needed' : (status.pgDumpVersion ?? 'Not found')}
          </dd>
        </div>
      </dl>

      {status.issues.length > 0 && (
        <Notice id={blockedId} tone="warning" title="Backups cannot run yet">
          <ul className="list-disc pl-4">
            {status.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Notice>
      )}
      {external && (
        <Notice tone="info" title="The database is backed up outside OCI">
          Each run backs up attachments only. OCI does not dump the database and cannot check that
          your own backup exists or works; {EXTERNAL_LIMIT} System health shows what it can read of
          WAL archiving. Test a restore with the restore drill in the administrator guide.
        </Notice>
      )}
      {external && !status.settings.copyFiles && (
        <Notice tone="warning" title="Nothing but a checksum list is backed up">
          The database is backed up outside OCI and attachment files are not copied, so a run only
          writes a list of attachments with their checksums. Turn on <em>Copy attachment files</em>{' '}
          below, or protect attachment storage separately (for example with bucket versioning).
        </Notice>
      )}
      {!external && !status.settings.copyFiles && (
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
        blockedBy={status.issues.length > 0 ? blockedId : null}
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

  // The errors are about the values sent: correcting a field clears its own
  // (#217), and the others stay while their fields are still wrong (#257).
  const [problems, setProblems] = useFieldProblems(draft);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<BackupStatus>('/admin/backups/settings', patch),
    onMutate: () => setProblems([]),
    onSuccess: async (next) => {
      queryClient.setQueryData(BACKUPS_QUERY_KEY, next);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'health'] });
    },
    onError: (cause) =>
      setProblems(apiErrorProblems(cause, 'Backup settings could not be saved.', BACKUP_LABELS)),
  });
  const patch = backupChanges(status, draft);
  const hasChanges = Object.keys(patch).length > 0;
  useReportUnsaved(hasChanges);
  // Each refusal under the field it names; any other beside Save (#302, #317's sweep).
  const at = (field: string) => problemsAt(problems, field);
  const shown = [
    'keepDaily',
    'keepWeekly',
    ...(draft.destination === 'separate' ? S3_BUCKET_FIELDS : []),
  ];

  // Choosing to stop dumping the database is asked about when it would take effect.
  const [confirmExternal, setConfirmExternal] = useState(false);
  const external = draft.databaseBackup === 'external';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!hasChanges) return;
    if (patch.databaseBackup === 'external') setConfirmExternal(true);
    else save.mutate(patch);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <ToggleSetting
        id="backups-enabled"
        label="Back up automatically"
        description={
          external
            ? 'Runs once a day and writes a manifest of attachment objects, and copies of the files when that is on, to S3-compatible storage. The database is not dumped.'
            : 'Runs pg_dump once a day and writes the archive, with a manifest of attachment objects, to S3-compatible storage. Leave off if this instance is backed up another way.'
        }
        checked={draft.enabled}
        disabled={false}
        onCheckedChange={(enabled) => set('enabled', enabled)}
      />
      <Field
        label="Database backup"
        htmlFor="backups-database-mode"
        hint={
          external
            ? `Your own tooling (CloudNativePG, pgBackRest, WAL-G, volume snapshots) backs up the database. OCI backs up attachments only and does not need the PostgreSQL client tools. ${EXTERNAL_LIMIT}`
            : 'OCI runs pg_dump and checks the archive by reading it back. Choose the other option if your own tooling already backs up the database.'
        }
      >
        <Select
          id="backups-database-mode"
          value={draft.databaseBackup}
          onChange={(value) => set('databaseBackup', value as BackupDatabaseMode)}
          options={DATABASE_MODES}
        />
      </Field>
      {external && (
        <ToggleSetting
          id="backups-wal-expected"
          label="WAL archiving is expected"
          description="System health warns when PostgreSQL is not archiving WAL, because point-in-time recovery is then not possible. Turn off if the database is backed up with volume snapshots only."
          checked={draft.walArchivingExpected}
          disabled={false}
          onCheckedChange={(expected) => set('walArchivingExpected', expected)}
        />
      )}
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
          errorAt={at}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <RetentionField
          id="backups-keep-daily"
          label="Daily backups kept"
          hint={`The newest backup of each of this many days (1–90).${external ? RECOVERY_WINDOW_HINT : ''}`}
          min={1}
          max={90}
          value={draft.keepDaily}
          error={at('keepDaily')}
          onChange={(value) => set('keepDaily', value)}
        />
        <RetentionField
          id="backups-keep-weekly"
          label="Weekly backups kept"
          hint="The newest backup of each of this many weeks (0–104)."
          min={0}
          max={104}
          value={draft.keepWeekly}
          error={at('keepWeekly')}
          onChange={(value) => set('keepWeekly', value)}
        />
      </div>

      <DestinationTest endpoint="/admin/backups/test" hasChanges={hasChanges} />

      <SaveRow
        hasChanges={hasChanges}
        isPending={save.isPending}
        errorMessage={problemsElsewhere(problems, shown)}
        successMessage={saved && !hasChanges ? 'Backup settings saved.' : null}
      />

      <ConfirmDialog
        open={confirmExternal}
        onOpenChange={setConfirmExternal}
        title="Stop dumping the database?"
        description="OCI will stop dumping the database. Check that your own backups work: OCI cannot."
        confirmLabel="Stop dumping the database"
        pendingLabel="Saving…"
        errorMessage="Backup settings could not be saved."
        onConfirm={() => save.mutateAsync(patch)}
      >
        <p className="text-sm text-[var(--text-muted)]">
          OCI keeps backing up attachments on the same schedule. Earlier dumps are deleted by
          retention as before.
        </p>
      </ConfirmDialog>
    </form>
  );
}

/**
 * Copies of attachments are kept while a kept backup lists them, so with the
 * database backed up elsewhere the days kept must reach back as far as the
 * database can be recovered to.
 */
const RECOVERY_WINDOW_HINT =
  ' Keep at least as many days as your database recovery window: a recovery point inside it can need an attachment copy that an expired backup listed.';

/** The form's names for the fields the API names differently (#127). */
const BACKUP_LABELS = {
  keepDaily: 'Daily backups kept',
  keepWeekly: 'Weekly backups kept',
  hourUtc: 'Time of day',
};

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
        // A run without a dump (the database is backed up outside OCI) has no size to print.
        `${run.dumpBytes === null ? '' : `${formatBytes(run.dumpBytes)} database · `}${run.attachmentCount ?? 0} attachment objects (${formatBytes(run.attachmentBytes ?? 0)})${run.verificationDetail ? ` · ${run.verificationDetail}` : ''}`
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
        description={
          status.data?.settings.databaseBackup === 'external'
            ? 'A checksummed manifest of attachment objects and, when turned on, copies of the files, written to S3-compatible storage and verified after every run. The database is backed up outside OCI. Restoring is a manual step, described in the administrator guide.'
            : 'A daily database dump, a checksummed manifest of attachment objects and, when turned on, copies of the files, written to S3-compatible storage and verified after every run. Restoring is a manual step, described in the administrator guide.'
        }
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
