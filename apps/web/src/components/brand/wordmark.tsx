import { cn } from '~/lib/utils';

const DEFAULT_NAME = 'Open Chat Interface';

/**
 * Instance wordmark. Long names collapse to their initials so admin branding
 * changes never break the sidebar header.
 */
export function Wordmark({ name, className }: { name?: string; className?: string }) {
  const label = name?.trim() || DEFAULT_NAME;
  const words = label.split(/\s+/);

  // Three or more words render as an acronym, matching the compact header.
  const display =
    words.length >= 3 ? words.map((word) => word[0]?.toUpperCase() ?? '').join('') : label;

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
