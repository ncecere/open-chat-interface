import { useId } from 'react';
import { cn } from '~/lib/utils';

/**
 * One radio of a group, with a hint that describes it rather than being part
 * of its name. The row is at least 44 px tall so it is easy to hit on a phone.
 */
export function ChoiceRow({
  name,
  value,
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div
      className={cn(
        'flex min-h-11 items-start gap-3 rounded-lg px-3 py-2.5 text-sm',
        checked ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
        disabled && 'opacity-50',
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={() => onChange(value)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer wrap-anywhere">
          {label}
        </label>
        {hint && (
          // Secondary, not muted: the chosen row is tinted, and muted text on the tint is under 4.5:1.
          <p id={hintId} className="text-xs text-[var(--text-secondary)]">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
