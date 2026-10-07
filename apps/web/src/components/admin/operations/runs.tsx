import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, LoaderCircle, type LucideIcon, Play } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { EmptyState, MutationError } from '~/components/admin/admin-ui';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { cn, formatDateTime } from '~/lib/utils';

/**
 * Runs of an operations job (a backup, a compliance export): starting one
 * now, and the history of recent runs. Shared by the Backups and Compliance
 * pages since v0.10.
 */

/** What every job's run has; each page adds its own details. */
export interface OperationRun {
  id: string;
  trigger: 'manual' | 'schedule';
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  errorMessage: string | null;
}

/** A local date and time, or a dash when there is none. */
export const formatRunTime = (iso: string | null) => (iso ? formatDateTime(iso) : '—');

/**
 * A run in progress, here and on Health's background jobs: a neutral turning
 * circle. It was the yellow warning triangle, so a run that was fine looked
 * like a problem until it finished (#305).
 */
export const RunningIcon = LoaderCircle;
export const RUNNING_ICON_CLASS =
  'animate-spin text-[var(--text-muted)] motion-reduce:animate-none';

export function RunStatusIcon({ status }: { status: OperationRun['status'] }) {
  const Icon = status === 'failed' ? CircleAlert : status === 'running' ? RunningIcon : CircleCheck;
  return (
    <Icon
      role="img"
      aria-label={status === 'failed' ? 'Failed' : status === 'running' ? 'Running' : 'Succeeded'}
      className={cn(
        'mt-0.5 size-4 shrink-0',
        status === 'failed'
          ? 'text-[var(--danger)]'
          : status === 'running'
            ? RUNNING_ICON_CLASS
            : 'text-[var(--success)]',
      )}
    />
  );
}

/**
 * "Back up now" / "Export now": starts a run through `endpoint` and refreshes
 * the page's status. Disabled while one runs or when the job cannot run.
 */
export function RunNowControl({
  endpoint,
  queryKey,
  label,
  running,
  blockedBy,
  runningText,
  startedText,
  errorMessage,
}: {
  endpoint: string;
  queryKey: QueryKey;
  label: string;
  /** A run is in progress. */
  running: boolean;
  /**
   * The id of the page's explanation of why the job cannot run as configured,
   * or null when it can. The disabled button points at it, so a screen reader
   * hears the reason, not just "dimmed" (#157, #261).
   */
  blockedBy: string | null;
  runningText: string;
  startedText: string;
  errorMessage: string;
}) {
  const queryClient = useQueryClient();
  const statusId = useId();
  const run = useMutation({
    mutationFn: () => api.post<{ started: boolean }>(endpoint),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  return (
    <>
      <EditOnly>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={run.isPending || running || blockedBy !== null}
            aria-describedby={
              blockedBy !== null && !running ? blockedBy : running ? statusId : undefined
            }
            onClick={() => run.mutate()}
          >
            {run.isPending ? <Spinner /> : <Play />}
            {label}
          </Button>
          <p id={statusId} aria-live="polite" className="text-sm text-[var(--text-muted)]">
            {running ? runningText : run.isSuccess ? startedText : ''}
          </p>
        </div>
      </EditOnly>
      <MutationError error={run.error} message={errorMessage} />
    </>
  );
}

/**
 * The recent runs, newest first: status, when, how it was started, what it
 * produced (size and counts) or why it failed, and the object it wrote. Each
 * page supplies the parts that differ: its badges, its summary of a
 * successful run, extra lines and the key shown for a kept run.
 */
export function RunHistory<Run extends OperationRun>({
  runs,
  testId,
  empty,
  badges,
  summary,
  details,
  objectKey,
}: {
  runs: Run[];
  /** `data-testid` of each row. */
  testId: string;
  empty: { icon: LucideIcon; title: string; body: ReactNode };
  badges: (run: Run) => ReactNode;
  /** The line for a successful run: its size and counts. */
  summary: (run: Run) => string;
  details?: (run: Run) => ReactNode;
  /** The object a kept successful run wrote, or null. */
  objectKey: (run: Run) => string | null;
}) {
  if (runs.length === 0)
    return (
      <EmptyState icon={empty.icon} title={empty.title}>
        {empty.body}
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
      {runs.map((run) => {
        const key = objectKey(run);
        return (
          <li key={run.id} className="flex items-start gap-3 px-4 py-3" data-testid={testId}>
            <RunStatusIcon status={run.status} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{formatRunTime(run.startedAt)}</p>
                <Badge variant="neutral">{run.trigger === 'manual' ? 'Manual' : 'Scheduled'}</Badge>
                {badges(run)}
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                {run.status === 'succeeded'
                  ? summary(run)
                  : run.status === 'running'
                    ? 'Running…'
                    : (run.errorMessage ?? 'Failed')}
              </p>
              {details?.(run)}
              {key && <p className="truncate font-mono text-xs text-[var(--text-muted)]">{key}</p>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
