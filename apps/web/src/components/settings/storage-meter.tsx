import type { StorageUsage } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Storage consumption against the role's allowance.
 *
 * Soft-deleted files are excluded from the bar because they no longer count
 * against the user: deleting to make room frees the space immediately rather
 * than at the end of the trash window.
 */
export function StorageMeter() {
  const { data } = useQuery({
    queryKey: ['attachments', 'usage'],
    queryFn: () => api.get<StorageUsage>('/attachments/usage'),
    staleTime: 15_000,
  });

  if (!data) return null;

  const hasByteLimit = data.maxTotalBytes !== null && data.maxTotalBytes > 0;
  const hasLimit = hasByteLimit || Boolean(data.maxFileCount);
  const percentUsed = hasByteLimit
    ? Math.min(100, (data.liveBytes / (data.maxTotalBytes as number)) * 100)
    : 0;
  const nearlyFull = percentUsed >= 80;

  return (
    <div className="mt-5 rounded-xl border border-[var(--border-subtle)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-sm">Storage used</p>
        <p className="text-[var(--text-muted)] text-xs">
          {formatBytes(data.liveBytes)}
          {hasByteLimit ? ` of ${formatBytes(data.maxTotalBytes as number)}` : ''} ·{' '}
          {data.liveFileCount.toLocaleString()}
          {data.maxFileCount ? ` of ${data.maxFileCount.toLocaleString()}` : ''} file
          {data.liveFileCount === 1 ? '' : 's'}
        </p>
      </div>

      {hasByteLimit && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-[var(--bg-segment-track)]">
          <div
            className={cn(
              'h-full rounded-full transition-[width]',
              nearlyFull ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]',
            )}
            style={{ width: `${percentUsed}%` }}
          />
        </div>
      )}

      {data.breakdown && (
        <dl
          aria-label="Storage by kind"
          className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-3"
        >
          {(
            [
              ['Chat files', data.breakdown.chatFiles, 'file'],
              ['Project files', data.breakdown.projectFiles, 'file'],
              ['Artifacts', data.breakdown.artifacts, 'artifact'],
            ] as const
          ).map(([label, share, noun]) => (
            <div key={label} className="flex items-baseline justify-between gap-2 sm:block">
              <dt className="text-[var(--text-secondary)]">{label}</dt>
              <dd className="text-[var(--text-muted)]">
                {formatBytes(share.bytes)} · {plural(share.count, noun)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-2 text-[var(--text-muted)] text-xs">
        {hasByteLimit
          ? nearlyFull
            ? 'You are close to your storage limit. Delete files to make room.'
            : `${formatBytes(Math.max(0, (data.maxTotalBytes as number) - data.liveBytes))} free.`
          : 'No storage limit applies to your role.'}
        {/* Files you deleted (gone for good, only waiting to be removed from
            storage) and those of conversations in the trash. There is no trash
            for files, so this does not say they are in one (#179). With no
            limit, it does not speak of one (#254). */}
        {data.pendingFileCount > 0 &&
          ` ${formatBytes(data.pendingBytes)} of deleted files, and of conversations in the trash, ${
            hasLimit
              ? 'no longer counts against your limit.'
              : 'is not counted in the storage used.'
          }`}
      </p>
    </div>
  );
}
