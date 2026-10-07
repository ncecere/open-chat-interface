export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export type OptionalLimit = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Reads an optional limit typed in `unit`s and returns it multiplied by
 * `scale` (for example GB to bytes). Blank means no limit (`null`). Anything
 * else must be a positive number that is still at least 1 once scaled and no
 * more than `max`: a mistyped 0, a negative or a stray letter is an error, never
 * a silent "no limit".
 */
export function parseOptionalLimit(
  value: string,
  {
    unit,
    scale = 1,
    max,
    wholeNumber = false,
  }: {
    unit: string;
    scale?: number;
    max: number;
    wholeNumber?: boolean;
  },
): OptionalLimit {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  const parsed = Number(trimmed);
  const largest = `${(max / scale).toLocaleString('en-US')} ${unit}`;
  const blank = 'or leave it blank for no limit';
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: `Enter a number greater than 0, ${blank}.` };
  }
  if (wholeNumber && !Number.isInteger(parsed)) {
    return { ok: false, error: `Enter a whole number, ${blank}.` };
  }
  const scaled = Math.round(parsed * scale);
  if (scaled < 1) return { ok: false, error: `Enter a larger number, ${blank}.` };
  if (scaled > max) return { ok: false, error: `The largest allowed is ${largest}.` };
  return { ok: true, value: scaled };
}
