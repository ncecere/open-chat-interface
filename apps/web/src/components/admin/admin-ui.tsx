import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { EditableFieldset, useAdminAccess } from '~/components/admin/admin-access';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, apiErrorMessage } from '~/lib/api-client';
import { cn } from '~/lib/utils';
import { describeValidationIssues } from '~/lib/validation-issues';

/**
 * A titled block separated by a rule rather than a card. This matches the
 * user-facing settings pages, which group content with headings only.
 *
 * On wide screens the heading sits in its own column beside the controls, so
 * forms use the available width without stretching into long lines. Pass
 * `stacked` where the section already sits in a narrow column.
 *
 * Its contents are an EditableFieldset: for a read-only viewer every control
 * inside is disabled, while links and text stay usable. Pass
 * `editable={false}` for a section whose controls only read (retry, refresh),
 * and gate any write inside it individually.
 */
export function SettingsSection({
  title,
  description,
  children,
  className,
  stacked = false,
  editable = true,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  stacked?: boolean;
  editable?: boolean;
}) {
  return (
    <section
      className={cn(
        'border-t border-[var(--border-subtle)] pt-8 first:border-t-0 first:pt-0',
        !stacked && 'xl:grid xl:grid-cols-[18rem_minmax(0,1fr)] xl:gap-10',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--text-muted)]">
            {description}
          </p>
        )}
      </div>
      {editable ? (
        <EditableFieldset className={cn('mt-5', !stacked && 'xl:mt-0')}>
          {children}
        </EditableFieldset>
      ) : (
        <div className={cn('mt-5 min-w-0', !stacked && 'xl:mt-0')}>{children}</div>
      )}
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
    // No wider than the page's description above it (#113).
    <div className="flex max-w-3xl flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-12 text-center">
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
  const { canEdit } = useAdminAccess();
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
        disabled={disabled || !canEdit}
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
  id,
}: {
  tone?: 'info' | 'warning';
  title: string;
  children: ReactNode;
  /** For a control the notice explains, to point at it (`aria-describedby`). */
  id?: string;
}) {
  const warning = tone === 'warning';
  const Icon = warning ? AlertTriangle : Info;

  return (
    <div
      id={id}
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

/**
 * Announces a failed mutation next to the control that triggered it.
 *
 * `message` says what failed; the server's own explanation follows when the
 * failure came from the API. Renders nothing while `error` is empty, so it
 * clears itself when React Query resets the mutation on retry or success.
 */
export function MutationError({
  error,
  message,
  className,
}: {
  error: unknown;
  message: string;
  className?: string;
}) {
  if (!error) return null;
  const issues = error instanceof ApiError ? describeValidationIssues(error.details) : [];
  // With field-level reasons, "Request validation failed" adds nothing.
  const detail =
    error instanceof ApiError && error.message !== message && issues.length === 0
      ? error.message
      : null;

  return (
    <div role="alert" className={cn('text-sm text-[var(--danger)]', className)}>
      <p>
        {message}
        {detail && ` ${detail}`}
      </p>
      {issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Shown in place of content whose query failed, so a page never spins
 * forever. Retrying refetches the same query.
 */
export function LoadError({
  title,
  query,
  className,
}: {
  title: string;
  query: { error: unknown; isFetching: boolean; refetch: () => unknown };
  className?: string;
}) {
  // Several sections can fail at once (System health has four); each Try
  // again points at what it reloads (#260).
  const titleId = useId();
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border-subtle)] p-12 text-center',
        className,
      )}
    >
      <AlertTriangle className="size-8 text-[var(--danger)]" aria-hidden="true" />
      <p id={titleId} role="alert" className="text-sm font-medium text-[var(--text-primary)]">
        {title}
      </p>
      <p className="max-w-md text-xs text-[var(--text-muted)]">
        {apiErrorMessage(query.error, 'Check your connection and try again.')}
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={query.isFetching}
        aria-describedby={titleId}
        onClick={() => void query.refetch()}
      >
        {query.isFetching && <Spinner />}
        Try again
      </Button>
    </div>
  );
}

export function SaveRow({
  hasChanges,
  isPending,
  errorMessage,
  successMessage,
  subject,
}: {
  hasChanges: boolean;
  isPending: boolean;
  errorMessage: string | null;
  successMessage: string | null;
  /**
   * What the button saves, where a page has several ("the system
   * instructions"): its accessible name becomes "Save changes to …" so the
   * buttons are told apart (#175). The visible text stays "Save changes".
   */
  subject?: string;
}) {
  // A read-only viewer cannot change anything, so there is nothing to save.
  const { canEdit } = useAdminAccess();
  if (!canEdit) return null;

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
      <Button
        type="submit"
        variant="primary"
        disabled={!hasChanges || isPending}
        aria-label={subject ? `Save changes to ${subject}` : undefined}
      >
        {isPending && <Spinner />}
        {isPending ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}
