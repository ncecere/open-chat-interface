import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Mail } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { z } from 'zod';
import { EditOnly } from '~/components/admin/admin-access';
import {
  AdminPageHeader,
  EmptyState,
  LoadError,
  MutationError,
  Notice,
} from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { FullPageSpinner } from '~/components/ui/spinner';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { useSetupCheck } from '~/hooks/use-setup-status';
import { api, apiErrorProblems } from '~/lib/api-client';
import { formatRelativeTime, plural } from '~/lib/utils';

interface ScheduledReport {
  id: string;
  name: string;
  cadence: 'daily' | 'weekly' | 'monthly';
  windowDays: number;
  recipients: string[];
  enabled: boolean;
  lastRunAt: string | null;
  /** Null while paused; now or earlier when due at the next hourly check. */
  nextRunAt: string | null;
  lastStatus: 'success' | 'error' | null;
  lastError: string | null;
}

/**
 * Reports are only useful once email can be delivered. Silent while the setup
 * status is loading or unavailable, so a slow check never flashes a warning.
 */
function EmailRequiredNotice() {
  const email = useSetupCheck('email');
  if (!email || email.status === 'complete') return null;

  return (
    <div className="mb-8">
      <Notice tone="warning" title="Reports need email delivery">
        <p>Scheduled reports are sent by email, so none will arrive until email delivery works.</p>
        <Link
          to="/admin/settings/email"
          className="mt-2 inline-block font-medium text-[var(--accent-bright)] hover:underline"
        >
          Configure email delivery
        </Link>
      </Notice>
    </div>
  );
}

/** "Next: in 3d", "Next: within the hour" when due, or "Paused" (#85, #126). */
export function nextRunText(report: Pick<ScheduledReport, 'nextRunAt'>, now = Date.now()): string {
  if (!report.nextRunAt) return 'Paused';
  const at = Date.parse(report.nextRunAt);
  if (at <= now + 60 * 60 * 1000) return 'Next: within the hour';
  return `Next: ${formatRelativeTime(report.nextRunAt, now)}`;
}

/** The form's names for the fields, so each error names the one it is about (#127, #283). */
const REPORT_LABELS = {
  name: 'Name',
  cadence: 'Cadence',
  windowDays: 'Window (days)',
  recipients: 'Recipients',
};

/** The addresses as the form sends them: split on commas and spaces, blanks dropped. */
function parseRecipients(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const email = z.email();

/**
 * The addresses that are not email addresses, named, as the API's own check
 * can only say "Recipients (item 1)", which the person has to count to (#283).
 * Null when every address is valid.
 */
export function recipientsProblem(recipients: readonly string[]): string | null {
  const invalid = recipients.filter((entry) => !email.safeParse(entry).success);
  if (invalid.length === 0) return null;
  const list = new Intl.ListFormat('en', { type: 'conjunction' }).format(invalid);
  return invalid.length === 1
    ? `Recipients: ${list} is not an email address.`
    : `Recipients: ${list} are not email addresses.`;
}

/** The fields that show their own errors; any other is shown above the button (#283). */
const FIELDS_SHOWN = ['name', 'windowDays', 'recipients'];

const CADENCES = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

export function AdminReportsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState('monthly');
  const [windowDays, setWindowDays] = useState(30);
  const [recipients, setRecipients] = useState('');
  const [deleteFor, setDeleteFor] = useState<ScheduledReport | null>(null);
  // The form adds a report, or saves changes to this one (#85).
  const [editing, setEditing] = useState<ScheduledReport | null>(null);
  // Leaving with a report half added, or an edit not saved, asks first (#45,
  // #300): against the report being edited, or the empty form.
  useReportUnsaved(
    editing
      ? name !== editing.name ||
          cadence !== editing.cadence ||
          windowDays !== editing.windowDays ||
          recipients !== editing.recipients.join(', ')
      : name !== '' || cadence !== 'monthly' || windowDays !== 30 || recipients !== '',
  );

  function resetForm() {
    setProblems([]);
    setEditing(null);
    setName('');
    setCadence('monthly');
    setWindowDays(30);
    setRecipients('');
  }

  function edit(report: ScheduledReport) {
    create.reset();
    setProblems([]);
    setEditing(report);
    setName(report.name);
    setCadence(report.cadence);
    setWindowDays(report.windowDays);
    setRecipients(report.recipients.join(', '));
    document.getElementById('report-name')?.focus();
  }

  const reports = useQuery({
    queryKey: ['admin', 'reports'],
    queryFn: () => api.get<{ reports: ScheduledReport[] }>('/admin/reports'),
  });
  const { data, isLoading } = reports;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'reports'] });

  // Each error is shown under its field, marked invalid, all at once, and
  // goes when that field is corrected (#217, #283).
  const form = useRef<HTMLFormElement>(null);
  const [problems, setProblems] = useFieldProblems({ name, cadence, windowDays, recipients }, form);
  const at = (field: keyof typeof REPORT_LABELS) => problemsAt(problems, field);
  const formError = problemsElsewhere(problems, FIELDS_SHOWN);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing ? api.patch(`/admin/reports/${editing.id}`, body) : api.post('/admin/reports', body),
    onMutate: () => setProblems([]),
    onSuccess: () => {
      resetForm();
      invalidate();
    },
    onError: (cause, body) => {
      const found = apiErrorProblems(
        cause,
        editing ? 'The report could not be saved.' : 'The report could not be added.',
        REPORT_LABELS,
      );
      // The API can only say "Recipients (item 2) must be a valid email
      // address"; the addresses are named instead (#283).
      const named = recipientsProblem((body.recipients as string[] | undefined) ?? []);
      setProblems(
        named
          ? [
              ...found.filter((problem) => problem.fields[0] !== 'recipients'),
              { fields: ['recipients'], text: named },
            ]
          : found,
      );
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`/admin/reports/${id}`, { enabled }),
    onSuccess: invalidate,
  });

  const runNow = useMutation({
    mutationFn: () => api.post<{ sent: number }>('/admin/reports/run', {}),
    onSuccess: invalidate,
  });

  async function deleteReport(report: ScheduledReport) {
    await api.delete(`/admin/reports/${report.id}`);
    if (editing?.id === report.id) resetForm();
    await invalidate();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    // No check of its own first: the API reports a blank name or a window
    // out of range together with the addresses, and stopping at a bad
    // address left those for the next save (#318), as #301 found in the
    // webhook and connector forms.
    create.mutate({ name, cadence, windowDays, recipients: parseRecipients(recipients) });
  }

  if (isLoading) return <FullPageSpinner />;

  const header = (
    <AdminPageHeader
      title="Scheduled reports"
      description="Usage summaries delivered by email, so a monthly figure does not depend on somebody remembering to look."
    />
  );

  if (reports.isError || !data) {
    return (
      <div>
        {header}
        <LoadError title="Scheduled reports could not be loaded." query={reports} />
      </div>
    );
  }

  return (
    <div>
      {header}

      <EmailRequiredNotice />

      {/* Adds a report, or edits the one chosen with Edit. */}
      <EditOnly>
        <form
          noValidate
          ref={form}
          onSubmit={submit}
          className="mb-8 grid gap-3 sm:grid-cols-2"
          aria-label={editing ? `Edit ${editing.name}` : 'Add report'}
        >
          {editing && <p className="text-sm font-medium sm:col-span-2">Editing {editing.name}</p>}
          <Field label="Name" htmlFor="report-name" error={at('name')}>
            <Input
              id="report-name"
              {...invalidFieldProps('report-name', at('name'))}
              value={name}
              required
              maxLength={120}
              placeholder="Monthly usage"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Cadence" htmlFor="report-cadence">
            <Select id="report-cadence" value={cadence} onChange={setCadence} options={CADENCES} />
          </Field>
          <Field
            label="Window (days)"
            htmlFor="report-window"
            error={at('windowDays')}
            hint="How much history each report covers."
          >
            <Input
              id="report-window"
              {...invalidFieldProps('report-window', at('windowDays'))}
              type="number"
              min={1}
              max={365}
              value={windowDays}
              onChange={(event) => setWindowDays(Number(event.target.value))}
            />
          </Field>
          <Field
            label="Recipients"
            htmlFor="report-recipients"
            error={at('recipients')}
            hint="Separate addresses with commas."
          >
            <Input
              id="report-recipients"
              {...invalidFieldProps('report-recipients', at('recipients'))}
              value={recipients}
              required
              placeholder="ops@example.com"
              onChange={(event) => setRecipients(event.target.value)}
            />
          </Field>
          <div className="flex flex-col gap-2 sm:col-span-2">
            {formError && (
              <p role="alert" className="whitespace-pre-line text-[var(--danger)] text-sm">
                {formError}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={create.isPending}>
                {editing ? 'Save report' : 'Add report'}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" onClick={resetForm}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </form>
      </EditOnly>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-base">Reports</h2>
          <EditOnly>
            <Button
              size="sm"
              variant="secondary"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate()}
            >
              Send due now
            </Button>
          </EditOnly>
        </div>

        <MutationError
          error={runNow.error}
          message="Due reports could not be sent."
          className="mt-2"
        />
        <MutationError
          error={toggle.error}
          message={`The report could not be ${toggle.variables?.enabled ? 'resumed' : 'paused'}.`}
          className="mt-2"
        />

        {runNow.data && (
          <p className="mt-2 text-[var(--text-muted)] text-sm">
            {runNow.data.sent === 0
              ? 'Nothing was due. A report is only sent once per cadence.'
              : `Sent ${runNow.data.sent} report${runNow.data.sent === 1 ? '' : 's'}.`}
          </p>
        )}

        {data.reports.length === 0 ? (
          // The same empty state as the other admin lists (#113).
          <div className="mt-3">
            <EmptyState icon={Mail} title="No reports scheduled.">
              Add one above to email a usage summary daily, weekly or monthly.
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {data.reports.map((report) => (
              <li key={report.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{report.name}</p>
                  <p className="text-[var(--text-muted)] text-xs">
                    {report.cadence} · {plural(report.windowDays, 'day')} ·{' '}
                    {report.recipients.join(', ')}
                  </p>
                  <p className="mt-0.5 text-[var(--text-muted)] text-xs">{nextRunText(report)}</p>
                  {report.lastRunAt && (
                    <p className="mt-0.5 text-xs">
                      <span
                        className={
                          report.lastStatus === 'error'
                            ? 'text-[var(--danger)]'
                            : 'text-[var(--text-muted)]'
                        }
                      >
                        {report.lastStatus === 'error'
                          ? `Failed: ${report.lastError}`
                          : `Last sent ${formatRelativeTime(report.lastRunAt)}`}
                      </span>
                    </p>
                  )}
                </div>

                <EditOnly>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${report.name}`}
                    onClick={() => edit(report)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={toggle.isPending}
                    // Named for the report, as Edit is, so each row's buttons differ (#175).
                    aria-label={`${report.enabled ? 'Pause' : 'Resume'} ${report.name}`}
                    onClick={() => toggle.mutate({ id: report.id, enabled: !report.enabled })}
                  >
                    {report.enabled ? 'Pause' : 'Resume'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${report.name}`}
                    onClick={() => setDeleteFor(report)}
                  >
                    Delete
                  </Button>
                </EditOnly>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(deleteFor)}
        onOpenChange={(open) => !open && setDeleteFor(null)}
        title={`Delete ${deleteFor?.name ?? 'report'}?`}
        description="Its recipients will stop receiving it. To stop it temporarily, pause it instead. This action cannot be undone."
        confirmLabel="Delete report"
        pendingLabel="Deleting…"
        errorMessage="The report could not be deleted."
        onConfirm={() => (deleteFor ? deleteReport(deleteFor) : Promise.resolve())}
      />
    </div>
  );
}
