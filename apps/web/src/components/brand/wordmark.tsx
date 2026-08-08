import { cn } from '~/lib/utils';

const DEFAULT_NAME = 'Open Chat Interface';

/** Initials, used when no short name is configured. */
function initialsOf(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length < 3) return label;
  return words.map((word) => word[0]?.toUpperCase() ?? '').join('');
}

/**
 * Instance wordmark.
 *
 * A configured logo replaces the text entirely, since an instance that has
 * uploaded a mark generally wants that rather than its name repeated beside it.
 * Without one, a short name is used if set, and otherwise a long name collapses
 * to initials so branding changes cannot break the sidebar header.
 */
export function Wordmark({
  name,
  shortName,
  logoUrl,
  compact = false,
  className,
}: {
  name?: string;
  shortName?: string | null;
  logoUrl?: string | null;
  /** Prefers the short form, for the narrow sidebar header. */
  compact?: boolean;
  className?: string;
}) {
  const label = name?.trim() || DEFAULT_NAME;

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={label}
        title={label}
        className={cn('h-8 w-auto max-w-full object-contain', className)}
      />
    );
  }

  const display = compact ? shortName?.trim() || initialsOf(label) : label;
  const [first, ...rest] = display.split(' ');

  return (
    <span
      className={cn(
        'font-semibold tracking-tight text-[var(--text-primary)]',
        display.length <= 4 ? 'text-[1.5rem]' : 'text-[1.25rem]',
        className,
      )}
      title={label}
    >
      {first}
      {rest.length > 0 && <span className="text-[var(--accent-bright)]"> {rest.join(' ')}</span>}
    </span>
  );
}
