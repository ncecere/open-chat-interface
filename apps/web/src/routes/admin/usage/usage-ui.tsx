import { LoadError } from '~/components/admin/admin-ui';
import { Spinner } from '~/components/ui/spinner';
import { dayIn, fillDays, type Range } from './usage-helpers';

export function StatGrid({ stats }: { stats: Array<{ label: string; value: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="min-w-0 rounded-xl border border-[var(--border-subtle)] p-4"
        >
          <dt className="truncate text-[var(--text-muted)] text-xs">{stat.label}</dt>
          <dd className="mt-1 truncate font-semibold text-xl">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A daily trend drawn as plain bars.
 *
 * A charting dependency would be a lot of weight for this; the project already
 * draws its usage meters the same way. The bars are a picture: its name says
 * the total and the busiest day, and "Show the numbers" lists every day for
 * keyboard, touch and screen-reader users.
 */
export function Trend({
  points,
  range,
  label,
  describe,
}: {
  points: Array<{ day: string; value: number }>;
  range: Range;
  label: string;
  describe: (point: { day: string; value: number }) => string;
}) {
  if (points.length === 0) {
    return <p className="text-[var(--text-muted)] text-sm">Nothing recorded in this range.</p>;
  }

  const filled = fillDays(points, range.days, dayIn(range.timezone, new Date()));
  const peak = Math.max(1, ...filled.map((point) => point.value));
  const busiest = filled.reduce((best, point) => (point.value > best.value ? point : best));
  const active = filled.filter((point) => point.value > 0);

  return (
    <div>
      <div
        className="flex h-32 items-end gap-0.5"
        role="img"
        aria-label={`${label}, ${filled[0]?.day} to ${filled.at(-1)?.day}: busiest ${describe(busiest)}; ${active.length} of ${filled.length} days had any.`}
      >
        {filled.map((point) => (
          <div
            key={point.day}
            className="group relative min-w-0 flex-1 rounded-t bg-[var(--accent)]/70 transition-colors hover:bg-[var(--accent)]"
            style={{
              height: point.value > 0 ? `${Math.max(2, (point.value / peak) * 100)}%` : '0',
            }}
          >
            <span className="-translate-x-1/2 pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden whitespace-nowrap rounded bg-[var(--bg-control-hover)] px-2 py-1 text-[10px] group-hover:block">
              {describe(point)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[var(--text-muted)] text-xs">
        <span>{filled[0]?.day}</span>
        <span>{filled.at(-1)?.day}</span>
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-[var(--text-secondary)]">Show the numbers</summary>
        <table className="mt-2 text-sm">
          <caption className="sr-only">{label}, days with any</caption>
          <tbody>
            {active.map((point) => (
              <tr key={point.day}>
                <td className="py-0.5 pr-6 text-[var(--text-muted)]">{point.day}</td>
                <td className="py-0.5">{describe(point).split(' · ').at(-1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-[var(--text-muted)] text-xs">Days not listed had none.</p>
      </details>
    </div>
  );
}

/** States what a capped list left out, so a partial view never reads as whole. */
export function TruncationNote({
  shown,
  total,
  noun,
}: {
  shown: number;
  total: number;
  noun: string;
}) {
  if (total <= shown) return null;
  return (
    <p className="mt-2 text-[var(--text-muted)] text-xs">
      Showing the top {shown} of {total.toLocaleString()} {noun}.
    </p>
  );
}

export function PeopleList({
  entries,
}: {
  entries: Array<{
    userId: string;
    name: string;
    email: string;
    primary: string;
    secondary: string;
  }>;
}) {
  if (entries.length === 0) {
    return <p className="text-[var(--text-muted)] text-sm">Nothing recorded in this range.</p>;
  }

  return (
    <section
      // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
      tabIndex={0}
      aria-label="Usage by person"
      className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
    >
      {entries.map((entry) => (
        <div
          key={entry.userId}
          className="flex items-center justify-between gap-4 border-[var(--border-subtle)] border-b px-4 py-3 last:border-0"
        >
          <div className="min-w-0">
            <p className="truncate font-medium text-sm" title={entry.name}>
              {entry.name}
            </p>
            <p className="truncate text-[var(--text-muted)] text-xs" title={entry.email}>
              {entry.email}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm">{entry.primary}</p>
            <p className="text-[var(--text-muted)] text-xs">{entry.secondary}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

/** A tab's spinner, or a retryable error once its query has failed. */
export function TabPending({
  query,
  title,
}: {
  query: { error: unknown; isError: boolean; isFetching: boolean; refetch: () => unknown };
  title: string;
}) {
  if (query.isError) return <LoadError title={title} query={query} />;
  return (
    <div role="status" aria-label="Loading">
      <Spinner className="mx-auto size-6" />
    </div>
  );
}
