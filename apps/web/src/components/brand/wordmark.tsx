import { instanceName } from '@oci/shared';
import { TurnsMark } from '~/components/brand/turns-mark';
import { cn } from '~/lib/utils';

/**
 * The longest name the compact header shows in full beside the mark; longer
 * names collapse to initials. "Open Chat Interface" (19) fits.
 */
const COMPACT_NAME_MAX = 20;

/** Initials, used when no short name is configured and the name is long. */
function initialsOf(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length < 3) return label;
  return words.map((word) => word[0]?.toUpperCase() ?? '').join('');
}

/** The text the compact (sidebar) header shows beside the mark. */
export function compactLabel(label: string, shortName?: string | null): string {
  const short = shortName?.trim();
  if (short) return short;
  return label.length <= COMPACT_NAME_MAX ? label : initialsOf(label);
}

/**
 * Instance wordmark.
 *
 * A configured logo replaces the mark and name entirely, since an instance
 * that has uploaded a mark generally wants that rather than its name repeated
 * beside it. Without one, the Open Chat Interface mark ("Turns") sits beside
 * the instance name, which stays live text so it is read, found and
 * translated like any other. In the compact header a short name is used if
 * set, and a long name collapses to initials so branding changes cannot break
 * the sidebar.
 */
export function Wordmark({
  name,
  shortName,
  logoUrl,
  compact = false,
  className,
}: {
  name?: string | null;
  shortName?: string | null;
  logoUrl?: string | null;
  /** Prefers the short form, for the narrow sidebar header. */
  compact?: boolean;
  className?: string;
}) {
  const label = instanceName(name);

  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={label}
        title={label}
        data-wordmark="logo"
        className={cn('h-8 w-auto max-w-full object-contain', className)}
      />
    );
  }

  const display = compact ? compactLabel(label, shortName) : label;

  return (
    <span
      data-wordmark="mark"
      className={cn(
        'inline-flex min-w-0 max-w-full items-center font-semibold tracking-tight text-[var(--text-primary)]',
        compact ? 'gap-2 text-sm' : 'gap-2.5 text-xl',
        className,
      )}
      title={display === label ? undefined : label}
    >
      <TurnsMark className={compact ? 'size-6' : 'size-8'} />
      <span className={compact ? 'min-w-0 truncate' : 'min-w-0 [overflow-wrap:anywhere]'}>
        {display}
      </span>
    </span>
  );
}
