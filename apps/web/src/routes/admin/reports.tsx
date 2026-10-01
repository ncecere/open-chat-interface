import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { AdminPageHeader, LoadError, MutationError } from '~/components/admin/admin-ui';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { FullPageSpinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';

interface ScheduledReport {
  id: string;
  name: string;
  cadence: 'daily' | 'weekly' | 'monthly';
  windowDays: number;
  recipients: string[];
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: 'success' | 'error' | null;
  lastError: string | null;
}

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

  const reports = useQuery({
    queryKey: ['admin', 'reports'],
    queryFn: () => api.get<{ reports: ScheduledReport[] }>('/admin/reports'),
  });
  const { data, isLoading } = reports;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'reports'] });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/admin/reports', body),
    onSuccess: () => {
      setName('');
      setRecipients('');
      invalidate();
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
    await invalidate();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({
      name,
      cadence,
      windowDays,
      recipients: recipients
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    });
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

      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="report-name">
          <Input
            id="report-name"
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
          hint="How much history each report covers."
        >
          <Input
            id="report-window"
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
          hint="Separate addresses with commas."
        >
          <Input
            id="report-recipients"
            value={recipients}
            required
            placeholder="ops@example.com"
            onChange={(event) => setRecipients(event.target.value)}
          />
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <MutationError error={create.error} message="The report could not be added." />
          <div>
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Add report
            </Button>
          </div>
        </div>
      </form>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-base">Reports</h2>
          <Button
            size="sm"
            variant="secondary"
            disabled={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            Send due now
          </Button>
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
          <p className="mt-3 text-[var(--text-muted)] text-sm">No reports scheduled.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {data.reports.map((report) => (
              <li key={report.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm">{report.name}</p>
                  <p className="text-[var(--text-muted)] text-xs">
                    {report.cadence} · {report.windowDays} days · {report.recipients.join(', ')}
                  </p>
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

                <Button
                  size="sm"
                  variant="ghost"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ id: report.id, enabled: !report.enabled })}
                >
                  {report.enabled ? 'Pause' : 'Resume'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleteFor(report)}>
                  Delete
                </Button>
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
