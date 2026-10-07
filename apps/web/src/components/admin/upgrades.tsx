import type {
  BackgroundMigrationSummary,
  PostStepSummary,
  UpgradeMode,
  UpgradeReport,
} from '@oci/shared';
import { BACKGROUND_MIGRATION_BATCH_SIZE, BACKGROUND_MIGRATION_PAUSE_MS } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { LoadError, MutationError, Notice } from '~/components/admin/admin-ui';
import { ProgressBar } from '~/components/admin/progress-bar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { formatRelativeTime } from '~/lib/utils';
import { formatBytes } from '~/routes/admin/lifecycle-shared';

/**
 * System health, Upgrades and Background work (v0.11 design, sections 1 and
 * 6): the upgrade preflight for this database and the running release, and
 * the background migrations the job runner is working through.
 */

const UPGRADE_KEY = ['admin', 'migrations', 'upgrade'] as const;
const BACKGROUND_KEY = ['admin', 'migrations', 'background'] as const;

const MODE: Record<
  UpgradeMode,
  { label: string; variant: 'success' | 'neutral' | 'warning' | 'danger' }
> = {
  current: { label: 'Up to date', variant: 'success' },
  rolling: { label: 'Rolling upgrade', variant: 'neutral' },
  window: { label: 'Needs a window', variant: 'warning' },
  blocked: { label: 'Blocked', variant: 'danger' },
};

function rows(value: number | null): string {
  return value === null ? 'rows unknown' : `${value.toLocaleString()} rows`;
}

/** "1 row", "9 rows". */
function rowCount(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? 'row' : 'rows'}`;
}

function PostStep({ step }: { step: PostStepSummary }) {
  const table = step.statement.tables.find((candidate) => candidate.exists);
  const state =
    step.state === 'finished'
      ? `Finished${step.durationMs === null ? '' : ` in ${step.durationMs.toLocaleString()} ms`}`
      : step.state === 'started'
        ? `Started, not finished (${step.attempts} attempt${step.attempts === 1 ? '' : 's'})`
        : 'Waiting for migrate --post';
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs">{step.name}</p>
        <span className="text-[var(--text-secondary)] text-xs">{state}</span>
      </div>
      <p className="mt-1 break-words text-[var(--text-muted)] text-xs">{step.statement.summary}</p>
      {table && (
        <p className="text-[var(--text-muted)] text-xs">
          {table.name}: {rows(table.rows)}, {formatBytes(table.bytes ?? 0)}
        </p>
      )}
      {step.index && step.state !== 'finished' && (
        <p className="text-[var(--text-muted)] text-xs">
          Builds {step.index.name ?? 'an index'}
          {step.index.estimatedBytes === null
            ? ''
            : `, about ${formatBytes(step.index.estimatedBytes)}${step.index.sizedFromStatistics ? '' : ' (rough)'}`}
          {step.index.invalidExists ? '; an interrupted build will be dropped and rebuilt' : ''}
        </p>
      )}
      {step.lastError && step.state !== 'finished' && (
        <p className="text-[var(--danger)] text-xs">{step.lastError}</p>
      )}
    </li>
  );
}

/** The preflight: running release and schema, pending work, and the verdict. */
export function UpgradesSection() {
  const report = useQuery({
    queryKey: UPGRADE_KEY,
    queryFn: () => api.get<UpgradeReport>('/admin/migrations/upgrade'),
    refetchInterval: 60_000,
  });
  if (report.isLoading) {
    return (
      <div role="status" aria-label="Loading the upgrade check">
        <Spinner className="mx-auto size-5" />
      </div>
    );
  }
  const data = report.data;
  if (!data) return <LoadError title="The upgrade check could not be loaded." query={report} />;
  const mode = MODE[data.verdict.mode];
  const slow = data.preDeploy.flatMap((migration) =>
    migration.statements
      .filter((statement) => !statement.fast)
      .map((statement) => ({ migration, statement })),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-[var(--border-subtle)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={mode.variant}>{mode.label}</Badge>
          <p className="font-medium text-sm">{data.verdict.summary}</p>
        </div>
        {data.verdict.reasons.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[var(--text-muted)] text-xs">
            {data.verdict.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>

      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-[var(--text-muted)] text-xs">Running release</dt>
          <dd className="mt-1 font-semibold text-lg">{data.bundled.version}</dd>
          <dd className="text-[var(--text-muted)] text-xs">
            {data.bundled.migrations} migrations, {data.bundled.postSteps} post-deploy step
            {data.bundled.postSteps === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)] text-xs">Database schema</dt>
          <dd className="mt-1 font-semibold text-lg">{data.database.release ?? 'Unknown'}</dd>
          <dd className="break-all text-[var(--text-muted)] text-xs">
            {data.database.latestMigration ?? 'A migration this release does not include'}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-muted)] text-xs">Indexes to build</dt>
          <dd className="mt-1 font-semibold text-lg">{data.indexes.toBuild}</dd>
          <dd className="text-[var(--text-muted)] text-xs">
            {data.indexes.toBuild > 0
              ? `About ${formatBytes(data.indexes.estimatedBytes)}; keep ${formatBytes(data.indexes.estimatedBytes * 2)} free`
              : 'None waiting'}
          </dd>
        </div>
      </dl>

      {data.preDeploy.length > 0 && (
        <Notice
          title={`${data.preDeploy.length} pre-deploy migration(s) not applied`}
          tone="warning"
        >
          {slow.length === 0
            ? 'Each is a catalog change or touches new or small tables.'
            : slow
                .map(({ migration, statement }) => `${migration.tag}: ${statement.reason}`)
                .join(' ')}
        </Notice>
      )}

      {data.requirements.length > 0 && (
        <Notice title="Unfinished work a later release needs" tone="warning">
          {data.requirements
            .map((item) => `${item.name} (${item.state}), required by ${item.requiredBy}`)
            .join('; ')}
        </Notice>
      )}

      {data.postDeploy.length > 0 && (
        <div>
          <h3 className="mb-2 font-medium text-sm">Post-deploy steps</h3>
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {data.postDeploy.map((step) => (
              <PostStep key={step.name} step={step} />
            ))}
          </ul>
        </div>
      )}

      {data.indexes.invalid.length > 0 && (
        <Notice title="Invalid indexes" tone="warning">
          Left by interrupted concurrent builds: {data.indexes.invalid.join(', ')}.
        </Notice>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<BackgroundMigrationSummary['status'], string> = {
  not_scheduled: 'Not scheduled',
  pending: 'Waiting',
  running: 'Running',
  paused: 'Paused',
  finished: 'Finished',
  failed: 'Failed',
};

function Pace({ migration }: { migration: BackgroundMigrationSummary }) {
  const queryClient = useQueryClient();
  const [batchSize, setBatchSize] = useState(String(migration.batchSize));
  const [pauseMs, setPauseMs] = useState(String(migration.pauseMs));
  const save = useMutation({
    mutationFn: () =>
      api.patch<BackgroundMigrationSummary>(
        `/admin/migrations/background/${encodeURIComponent(migration.name)}`,
        {
          batchSize: Number(batchSize),
          pauseMs: Number(pauseMs),
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BACKGROUND_KEY }),
  });
  const changed =
    batchSize !== String(migration.batchSize) || pauseMs !== String(migration.pauseMs);
  const id = `migration-${migration.name.replace(/[^A-Za-z0-9]/g, '-')}`;
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label
        className="flex flex-col gap-1 text-[var(--text-muted)] text-xs"
        htmlFor={`${id}-batch`}
      >
        Rows per batch
        <Input
          id={`${id}-batch`}
          type="number"
          className="w-28"
          min={BACKGROUND_MIGRATION_BATCH_SIZE.min}
          max={BACKGROUND_MIGRATION_BATCH_SIZE.max}
          value={batchSize}
          onChange={(event) => setBatchSize(event.target.value)}
        />
      </label>
      <label
        className="flex flex-col gap-1 text-[var(--text-muted)] text-xs"
        htmlFor={`${id}-pause`}
      >
        Pause between batches (ms)
        <Input
          id={`${id}-pause`}
          type="number"
          className="w-28"
          min={BACKGROUND_MIGRATION_PAUSE_MS.min}
          max={BACKGROUND_MIGRATION_PAUSE_MS.max}
          value={pauseMs}
          onChange={(event) => setPauseMs(event.target.value)}
        />
      </label>
      <Button type="submit" variant="secondary" size="sm" disabled={!changed || save.isPending}>
        {save.isPending && <Spinner />}
        Save
      </Button>
      <MutationError error={save.error} message="The pace could not be changed." />
    </form>
  );
}

function BackgroundRow({ migration }: { migration: BackgroundMigrationSummary }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (action: 'pause' | 'resume') =>
      api.post<BackgroundMigrationSummary>(
        `/admin/migrations/background/${encodeURIComponent(migration.name)}/${action}`,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: BACKGROUND_KEY }),
        queryClient.invalidateQueries({ queryKey: UPGRADE_KEY }),
      ]),
  });
  const percent = migration.progress === null ? null : Math.round(migration.progress * 100);
  const canPause = ['pending', 'running', 'failed'].includes(migration.status) && migration.bundled;
  const canResume = ['paused', 'failed'].includes(migration.status) && migration.bundled;
  const scheduled = migration.status !== 'not_scheduled';
  // Without an estimate there is no "of about": "9 rows processed", not
  // "9 of about rows unknown" (#263). Nor once finished: the rows it changed
  // are not the table's, so "404 of about 577 rows (100%)" disagreed with
  // itself (#281).
  const progressText = `${
    migration.estimatedRows === null || migration.status === 'finished'
      ? `${rowCount(migration.rowsProcessed)} processed`
      : `${migration.rowsProcessed.toLocaleString()} of about ${rowCount(migration.estimatedRows)}`
  }${percent === null ? '' : ` (${percent}%)`}`;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs">{migration.name}</p>
          <p className="text-[var(--text-muted)] text-xs">
            {migration.description ?? 'Scheduled by a newer release; this release cannot run it.'}{' '}
            On {migration.table}
            {migration.tableBytes === null ? '' : ` (${formatBytes(migration.tableBytes)})`}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              migration.status === 'failed'
                ? 'danger'
                : migration.status === 'finished'
                  ? 'success'
                  : 'neutral'
            }
          >
            {STATUS_LABEL[migration.status]}
          </Badge>
          <EditOnly>
            {canResume ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`Resume ${migration.name}`}
                disabled={toggle.isPending}
                onClick={() => toggle.mutate('resume')}
              >
                <Play /> Resume
              </Button>
            ) : canPause ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`Pause ${migration.name}`}
                disabled={toggle.isPending}
                onClick={() => toggle.mutate('pause')}
              >
                <Pause /> Pause
              </Button>
            ) : null}
          </EditOnly>
        </div>
      </div>
      {scheduled && (
        <>
          <ProgressBar
            className="mt-2"
            value={percent ?? 0}
            max={100}
            label={`${migration.name} progress`}
            valueText={progressText}
            tone={
              migration.status === 'failed'
                ? 'danger'
                : migration.status === 'finished'
                  ? 'success'
                  : 'neutral'
            }
          />
          <p className="mt-1 text-[var(--text-muted)] text-xs">
            {progressText}
            {migration.finishedAt ? ` · finished ${formatRelativeTime(migration.finishedAt)}` : ''}
            {migration.status === 'running' && migration.throttledReason
              ? ` · waiting: ${migration.throttledReason}`
              : ''}
          </p>
        </>
      )}
      {!scheduled && (
        <p className="mt-1 text-[var(--text-muted)] text-xs">
          Runs after `migrate --post` schedules it.
        </p>
      )}
      {migration.lastError && migration.status !== 'finished' && (
        <p className="mt-1 text-[var(--danger)] text-xs">
          Last error{migration.attempts > 0 ? ` (${migration.attempts} in a row)` : ''}:{' '}
          {migration.lastError}
        </p>
      )}
      <MutationError error={toggle.error} message={`${migration.name} could not be changed.`} />
      {scheduled && migration.bundled && migration.status !== 'finished' && (
        <EditOnly>
          <Pace migration={migration} />
        </EditOnly>
      )}
    </li>
  );
}

/** Background migrations with progress and, for administrators, pause, resume and pace. */
export function BackgroundWorkSection() {
  const list = useQuery({
    queryKey: BACKGROUND_KEY,
    queryFn: () =>
      api.get<{ migrations: BackgroundMigrationSummary[] }>('/admin/migrations/background'),
    // Faster while something runs, so progress moves while the page is open.
    refetchInterval: (query) =>
      query.state.data?.migrations.some(
        (item) => item.status === 'running' || item.status === 'pending',
      )
        ? 5_000
        : 60_000,
  });
  if (list.isLoading) {
    return (
      <div role="status" aria-label="Loading background migrations">
        <Spinner className="mx-auto size-5" />
      </div>
    );
  }
  if (!list.data)
    return <LoadError title="Background migrations could not be loaded." query={list} />;
  if (list.data.migrations.length === 0) {
    return (
      <p className="text-[var(--text-muted)] text-sm">
        No background migrations. Releases that rewrite existing rows schedule them with `migrate
        --post`.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
      {list.data.migrations.map((migration) => (
        <BackgroundRow key={migration.name} migration={migration} />
      ))}
    </ul>
  );
}
