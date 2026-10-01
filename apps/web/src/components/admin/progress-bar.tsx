import { cn } from '~/lib/utils';

export type ProgressTone = 'neutral' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<ProgressTone, string> = {
  neutral: 'bg-[var(--accent)]',
  success: 'bg-[var(--success)]',
  warning: 'bg-[var(--warning)]',
  danger: 'bg-[var(--danger)]',
};

/**
 * A filled bar exposed as a progressbar, so a screen reader hears the same
 * figure the bar draws. Colour only reinforces the text shown beside it.
 */
export function ProgressBar({
  value,
  max,
  label,
  valueText,
  tone = 'neutral',
  className,
}: {
  value: number;
  max: number;
  /** Accessible name, such as "Daily budget used". */
  label: string;
  /** Spoken value, such as "40 of 100 messages". */
  valueText: string;
  tone?: ProgressTone;
  className?: string;
}) {
  const fraction = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(value, 0), max)}
      aria-valuetext={valueText}
      className={cn('h-1.5 overflow-hidden rounded-full bg-[var(--bg-segment-track)]', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width]', TONE_CLASS[tone])}
        style={{ width: `${fraction * 100}%` }}
      />
    </div>
  );
}
