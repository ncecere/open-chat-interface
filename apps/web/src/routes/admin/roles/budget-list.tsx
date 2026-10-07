import { MICROS_PER_DOLLAR, type RoleAccess } from '@oci/shared';
import { Link } from '@tanstack/react-router';
import { plural } from '~/lib/utils';

function formatBudgetLimit(budget: RoleAccess['budgets'][number]): string {
  if (budget.metric !== 'cost') {
    // "1 message", not "1 messages" (#286).
    return plural(budget.limitValue, budget.metric.slice(0, -1));
  }
  const dollars = budget.limitValue / MICROS_PER_DOLLAR;
  return `$${dollars.toFixed(dollars > 0 && dollars < 0.01 ? 4 : 2)}`;
}

function formatBudgetWindow(budget: RoleAccess['budgets'][number]): string {
  return budget.windowKind === 'rolling'
    ? `Rolling ${plural(budget.windowHours ?? 24, 'hour')}`
    : budget.windowKind.charAt(0).toUpperCase() + budget.windowKind.slice(1);
}

const METRIC_LABELS: Record<RoleAccess['budgets'][number]['metric'], string> = {
  messages: 'Messages',
  tokens: 'Tokens',
  cost: 'Cost',
};

export function BudgetList({ access }: { access: RoleAccess }) {
  return (
    <div className="flex flex-col gap-3">
      {access.budgets.length === 0 ? (
        <p className="text-[var(--text-muted)] text-sm">
          No usage budget applies to this role, so usage is limited only by the rate limits above.
        </p>
      ) : (
        <section
          // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
          tabIndex={0}
          aria-label="Usage budgets for this role"
          className="relative overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
        >
          <table className="w-full min-w-[32rem] text-sm">
            <thead className="bg-[var(--bg-control-alt)] text-left text-[var(--text-muted)] text-xs">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Metric
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Limit
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Window
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {access.budgets.map((budget) => (
                <tr key={budget.id} className="border-[var(--border-subtle)] border-t">
                  <td className="px-4 py-2 font-medium">{budget.name}</td>
                  <td className="px-4 py-2">{METRIC_LABELS[budget.metric]}</td>
                  <td className="px-4 py-2">{formatBudgetLimit(budget)}</td>
                  <td className="px-4 py-2">{formatBudgetWindow(budget)}</td>
                  <td className="px-4 py-2 text-[var(--text-muted)]">
                    {budget.enabled ? 'Enabled' : 'Disabled'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <Link to="/admin/quotas" className="text-[var(--accent-bright)] text-sm hover:underline">
        Manage usage budgets
      </Link>
    </div>
  );
}
