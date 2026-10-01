import type { SetupCheck, SetupCheckStatus } from '@oci/shared';
import { Link, type LinkProps } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, ChevronDown, Circle } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { LoadError } from '~/components/admin/admin-ui';
import { ProgressBar } from '~/components/admin/progress-bar';
import { buttonVariants } from '~/components/ui/button';
import { useSetupStatus } from '~/hooks/use-setup-status';
import { cn } from '~/lib/utils';

const STATUS_PRESENTATION: Record<
  SetupCheckStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  attention: {
    label: 'Needs attention',
    icon: AlertTriangle,
    className: 'text-[var(--warning)]',
  },
  complete: { label: 'Complete', icon: CheckCircle2, className: 'text-[var(--success)]' },
  optional: { label: 'Not set up', icon: Circle, className: 'text-[var(--text-muted)]' },
};

/** Icon and words together, so status never depends on colour alone. */
function StatusIndicator({ check }: { check: SetupCheck }) {
  const { label, icon: Icon, className } = STATUS_PRESENTATION[check.status];
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs font-medium', className)}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
      {check.status === 'attention' && check.required && (
        <span className="text-[var(--text-muted)]">· Required</span>
      )}
    </span>
  );
}

function CheckRow({ check }: { check: SetupCheck }) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <StatusIndicator check={check} />
        <p className="mt-1 font-medium text-[var(--text-primary)] text-sm">{check.title}</p>
        <p className="mt-0.5 text-[var(--text-muted)] text-sm leading-relaxed">{check.detail}</p>
      </div>
      {/* Navigation only: the linked page applies its own permissions. */}
      <Link
        to={check.action.to as LinkProps['to']}
        className={cn(
          buttonVariants({ variant: 'secondary', size: 'sm' }),
          'self-start sm:self-auto',
        )}
      >
        {check.action.label}
      </Link>
    </li>
  );
}

function CheckGroup({ title, checks }: { title?: string; checks: SetupCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="mt-4">
      {title && (
        <h3 className="mb-2 font-medium text-[var(--text-muted)] text-xs uppercase tracking-wider">
          {title}
        </h3>
      )}
      <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)]">
        {checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>
    </div>
  );
}

/** A button that shows or hides a region, announcing which with aria-expanded. */
function Disclosure({
  label,
  expanded,
  onToggle,
  controls,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className="mt-4 inline-flex items-center gap-1 rounded text-[var(--text-secondary)] text-sm hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--border-strong)]"
    >
      <ChevronDown
        className={cn('size-4 transition-transform', expanded && 'rotate-180')}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}

/** Attention first, required before optional; otherwise the server's order. */
export function groupSetupChecks(checks: SetupCheck[]) {
  const attention = checks
    .filter((check) => check.status === 'attention')
    .sort((a, b) => Number(b.required) - Number(a.required));
  return {
    attention,
    optional: checks.filter((check) => check.status === 'optional'),
    complete: checks.filter((check) => check.status === 'complete'),
  };
}

function ChecklistSkeleton() {
  return (
    <div role="status" aria-label="Loading setup status" className="mt-4 flex flex-col gap-2">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-16 animate-pulse rounded-xl bg-[var(--bg-control)]/60 motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

/**
 * What an administrator still has to do before the instance works as
 * intended, computed by the server from stored configuration. Each row links
 * to the page that resolves it. Read-only viewers see the same list: the
 * links only navigate.
 */
export function SetupChecklist() {
  const query = useSetupStatus();
  const [showCompleted, setShowCompleted] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const headingId = useId();
  const completedId = useId();
  const detailsId = useId();

  const frame = (children: ReactNode) => (
    <section
      aria-labelledby={headingId}
      className="mb-8 rounded-xl border border-[var(--border-subtle)] p-4 sm:p-5"
    >
      {children}
    </section>
  );

  if (query.isLoading) {
    return frame(
      <>
        <h2 id={headingId} className="font-semibold text-base">
          Setup
        </h2>
        <ChecklistSkeleton />
      </>,
    );
  }

  if (!query.data) {
    return frame(
      <>
        <h2 id={headingId} className="font-semibold text-base">
          Setup
        </h2>
        <LoadError title="Setup status could not be loaded." query={query} className="mt-4 p-6" />
      </>,
    );
  }

  const { requiredComplete, requiredTotal, checks } = query.data;
  const { attention, optional, complete } = groupSetupChecks(checks);
  const done = requiredComplete >= requiredTotal;
  const progress = `${requiredComplete} of ${requiredTotal} required step${requiredTotal === 1 ? '' : 's'} complete`;

  const completedList = (
    <>
      <Disclosure
        label={showCompleted ? 'Hide completed' : `Show completed (${complete.length})`}
        expanded={showCompleted}
        onToggle={() => setShowCompleted((value) => !value)}
        controls={completedId}
      />
      <div id={completedId} hidden={!showCompleted}>
        {showCompleted && <CheckGroup checks={complete} />}
      </div>
    </>
  );

  if (done) {
    return frame(
      <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CheckCircle2 className="size-5 shrink-0 text-[var(--success)]" aria-hidden="true" />
          <h2 id={headingId} className="font-semibold text-base">
            Setup complete
          </h2>
          <p className="text-[var(--text-muted)] text-sm">{progress}.</p>
        </div>
        {/* Something switched on but broken still needs saying. */}
        <CheckGroup checks={attention} />
        <Disclosure
          label={showDetails ? 'Hide setup details' : 'Show setup details'}
          expanded={showDetails}
          onToggle={() => setShowDetails((value) => !value)}
          controls={detailsId}
        />
        <div id={detailsId} hidden={!showDetails}>
          {showDetails && (
            <>
              <CheckGroup title="Optional" checks={optional} />
              <CheckGroup title="Completed" checks={complete} />
            </>
          )}
        </div>
      </>,
    );
  }

  return frame(
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="font-semibold text-base">
          Setup
        </h2>
        <p className="text-[var(--text-muted)] text-sm">{progress}</p>
      </div>
      <ProgressBar
        className="mt-3"
        value={requiredComplete}
        max={requiredTotal}
        label="Required setup steps complete"
        valueText={progress}
      />
      <CheckGroup checks={attention} />
      <CheckGroup title="Optional" checks={optional} />
      {complete.length > 0 && completedList}
    </>,
  );
}
