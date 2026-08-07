import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { cn } from '~/lib/utils';

/**
 * A titled block separated by a rule rather than a card. This matches the
 * user-facing settings pages, which group content with headings only.
 */
export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'border-t border-[var(--border-subtle)] pt-8 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
      {description && (
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
          {description}
        </p>
      )}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** Page heading shared by every admin route. */
export function AdminPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pb-8">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold">{title}</h1>
        {description && (
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-[var(--text-muted)]">
            {description}
          </p>
        )}
      </div>
      {actions}
    </div>
  );
}

/**
 * A bordered row list used where admin pages previously stacked one card per
 * record. Keeps records visually grouped without a card each.
 */
export function RowList({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-xl border border-[var(--border-subtle)]">
      {children}
    </div>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 px-4 py-3 transition-colors hover:bg-[var(--bg-control)]/40',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Centered guidance shown when a list has no records yet. */
export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-12 text-center">
      <Icon className="size-8 text-[var(--text-muted)]" />
      <p className="text-sm text-[var(--text-secondary)]">{title}</p>
      {children && <p className="max-w-md text-xs text-[var(--text-muted)]">{children}</p>}
    </div>
  );
}

export function ToggleSetting({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const descriptionId = `${id}-description`;

  return (
    <div className="flex items-start justify-between gap-6 py-5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-[var(--text-primary)]">
          {label}
        </label>
        <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-describedby={descriptionId}
      />
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning';
  title: string;
  children: ReactNode;
}) {
  const warning = tone === 'warning';
  const Icon = warning ? AlertTriangle : Info;

  return (
    <div
      role={warning ? 'alert' : 'status'}
      className={`flex gap-3 rounded-xl border p-4 text-sm ${
        warning
          ? 'border-[var(--warning)]/40 bg-[var(--warning)]/10'
          : 'border-[var(--border-subtle)] bg-[var(--bg-control)]/45'
      }`}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${
          warning ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'
        }`}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="font-medium text-[var(--text-primary)]">{title}</p>
        <div className="mt-1 leading-relaxed text-[var(--text-muted)]">{children}</div>
      </div>
    </div>
  );
}

export function SaveRow({
  hasChanges,
  isPending,
  errorMessage,
  successMessage,
}: {
  hasChanges: boolean;
  isPending: boolean;
  errorMessage: string | null;
  successMessage: string | null;
}) {
  return (
    <div className="flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
      <div className="sm:mr-auto" aria-live="polite">
        {errorMessage && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {errorMessage}
          </p>
        )}
        {successMessage && (
          <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
            <CheckCircle2 className="size-4" aria-hidden="true" />
            {successMessage}
          </p>
        )}
      </div>
      <Button type="submit" variant="primary" disabled={!hasChanges || isPending}>
        {isPending && <Spinner />}
        {isPending ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}
