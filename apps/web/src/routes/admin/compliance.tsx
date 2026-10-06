import type { ComplianceRun, ComplianceSchedule, ComplianceStatus, LegalHold } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileLock, Scale } from 'lucide-react';
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
import {
  type DestinationDraft,
  DestinationSelect,
  DestinationTest,
  destinationChanges,
  destinationDraftFrom,
  S3BucketFields,
} from '~/components/admin/operations/destination';
import { formatRunTime, RunHistory, RunNowControl } from '~/components/admin/operations/runs';
import {
  formatHourUtc,
  HourField,
  IntervalField,
  RetentionField,
} from '~/components/admin/operations/schedule';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { ADMIN_USERS_QUERY_KEY } from '~/components/admin/user-role-select';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { useClearOnEdit } from '~/hooks/use-clear-on-edit';
import { api, apiErrorMessage } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';
import { formatBytes } from '~/routes/admin/lifecycle-shared';

export const COMPLIANCE_QUERY_KEY = ['admin', 'compliance'] as const;

const SCHEDULES: Array<{ value: ComplianceSchedule; label: string }> = [
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Once a day' },
];

interface Draft extends DestinationDraft {
  enabled: boolean;
  schedule: ComplianceSchedule;
  hourUtc: number;
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
    ...destinationDraftFrom(settings),
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
  Object.assign(patch, destinationChanges(settings, draft));
  if (draft.includeContent !== settings.includeContent) patch.includeContent = draft.includeContent;
  const keepDays = draft.keepDays.trim() ? Number(draft.keepDays) : null;
  if (keepDays !== settings.keepDays) patch.keepDays = keepDays;
  return patch;
}

const when = formatRunTime;

function scheduleLabel(status: ComplianceStatus): string {
  const { settings } = status;
  if (!settings.enabled) return 'Off';
  return settings.schedule === 'hourly'
    ? 'Every hour'
    : `Daily at ${formatHourUtc(settings.hourUtc)}`;
}

function Overview({ status }: { status: ComplianceStatus }) {
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

      <RunNowControl
        endpoint="/admin/compliance/run"
        queryKey={COMPLIANCE_QUERY_KEY}
        label="Export now"
        running={status.running}
        blocked={status.issues.length > 0}
        runningText="An export is running. This page updates when it finishes."
        startedText="Export started."
        errorMessage="The export could not be started."
      />
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
  const patch = complianceChanges(status, draft);
  const hasChanges = Object.keys(patch).length > 0;
  useReportUnsaved(hasChanges);

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
        <IntervalField
          id="compliance-schedule"
          value={draft.schedule}
          options={SCHEDULES}
          onChange={(schedule) => set('schedule', schedule)}
        />
        {draft.schedule === 'daily' && (
          <HourField
            id="compliance-hour"
            hint="The daily export starts within a few minutes of this hour."
            value={draft.hourUtc}
            onChange={(hour) => set('hourUtc', hour)}
          />
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

      <DestinationSelect
        idPrefix="compliance"
        value={draft.destination}
        onChange={(destination) => set('destination', destination)}
        hint={
          draft.destination === 'storage'
            ? `Written to ${status.attachmentStorage.bucket ? `the ${status.attachmentStorage.bucket} bucket` : 'the attachment bucket'} under .oci-compliance/.`
            : 'Its own bucket and credentials. Recommended: give it object lock or versioning so records cannot be altered.'
        }
      />

      {draft.destination === 'separate' && (
        <S3BucketFields
          idPrefix="compliance"
          draft={draft}
          onChange={(change) => {
            setSaved(false);
            setDraft((current) => ({ ...current, ...change }));
          }}
          hasCredential={status.settings.s3.hasCredential}
          prefixHint="Folder for exports, ending with /."
        />
      )}

      <RetentionField
        id="compliance-keep-days"
        label="Delete exported objects after (days)"
        hint="Leave empty to keep them, the default: institutions usually manage these records themselves. Deleting old objects never exports their events again."
        min={1}
        max={3650}
        placeholder="Keep"
        value={draft.keepDays}
        onChange={(value) => set('keepDays', value)}
      />

      <DestinationTest endpoint="/admin/compliance/test" hasChanges={hasChanges} />

      <SaveRow
        hasChanges={hasChanges}
        isPending={save.isPending}
        errorMessage={
          save.error ? apiErrorMessage(save.error, 'Compliance settings could not be saved.') : null
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
  // "No account has that address" is about the address sent (#217).
  useClearOnEdit({ email, reason }, () => place.reset());

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
  return (
    <RunHistory
      runs={runs}
      testId="compliance-run"
      empty={{
        icon: FileLock,
        title: 'No exports yet.',
        body: 'Turn on the export or export now. Each run is verified by reading its objects back.',
      }}
      badges={(run) => (
        <>
          {run.status === 'succeeded' && run.manifestKey && (
            <Badge variant="success">Verified</Badge>
          )}
          {run.prunedAt && <Badge variant="outline">Deleted</Badge>}
        </>
      )}
      summary={(run) =>
        run.manifestKey
          ? `${run.audit.count ?? 0} audit events${run.messages ? ` · ${run.messages.count ?? 0} messages` : ''} · ${formatBytes((run.audit.bytes ?? 0) + (run.messages?.bytes ?? 0))}`
          : 'Nothing new to export.'
      }
      objectKey={(run) =>
        run.manifestKey && run.status === 'succeeded' && !run.prunedAt ? run.manifestKey : null
      }
    />
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
