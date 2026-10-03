import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';

/**
 * When an operations job runs and how long its output is kept: the controls
 * the Backups and Compliance pages share (v0.10).
 */

/** "03:00 UTC". */
export function formatHourUtc(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00 UTC`;
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: formatHourUtc(hour),
}));

/** The hour of the day (UTC) a daily run starts. */
export function HourField({
  id,
  hint,
  value,
  onChange,
}: {
  id: string;
  hint: string;
  value: number;
  onChange: (hour: number) => void;
}) {
  return (
    <Field label="Time of day" htmlFor={id} hint={hint}>
      <Select
        id={id}
        value={String(value)}
        onChange={(next) => onChange(Number(next))}
        options={HOUR_OPTIONS}
      />
    </Field>
  );
}

/** How often a job runs, from the intervals that job offers. */
export function IntervalField<T extends string>({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <Field label="How often" htmlFor={id}>
      <Select id={id} value={value} onChange={(next) => onChange(next as T)} options={options} />
    </Field>
  );
}

/**
 * A retention count or age, typed as text so it can be empty while edited
 * (and, where `placeholder` says so, left empty on purpose).
 */
export function RetentionField({
  id,
  label,
  hint,
  min,
  max,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
