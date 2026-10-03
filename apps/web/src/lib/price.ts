import { MICROS_PER_DOLLAR } from '@oci/shared';

/**
 * A dollar price typed into an admin form, in micro-dollars: null when the
 * field is empty (no price), undefined when it is not a non-negative number.
 */
export function priceMicros(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed * MICROS_PER_DOLLAR)
    : undefined;
}
