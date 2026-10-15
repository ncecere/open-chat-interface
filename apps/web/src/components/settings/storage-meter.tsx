import type { StorageUsage } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';
import { formatFileSize as formatBytes, useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

/**
 * Storage consumption against the role's allowance.
 *
 * Soft-deleted files are excluded from the bar because they no longer count
 * against the user: deleting to make room frees the space immediately rather
 * than at the end of the trash window.
 */
export function StorageMeter() {
  const t = useT();
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
        <p className="font-medium text-sm">{t('settings.storage.used')}</p>
        <p className="text-[var(--text-muted)] text-xs">
          {t('settings.storage.summary', {
            bytes: hasByteLimit
              ? t('settings.storage.bytesOf', {
                  used: formatBytes(data.liveBytes),
                  limit: formatBytes(data.maxTotalBytes as number),
                })
              : formatBytes(data.liveBytes),
            files: data.maxFileCount
              ? t('settings.storage.filesOf', {
                  count: data.liveFileCount,
                  max: data.maxFileCount,
                })
              : t('settings.storage.files', { count: data.liveFileCount }),
          })}
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
          aria-label={t('settings.storage.byKind')}
          className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-3"
        >
          {(
            [
              ['chat', t('settings.storage.chatFiles'), data.breakdown.chatFiles, false],
              ['project', t('settings.storage.projectFiles'), data.breakdown.projectFiles, false],
              ['artifacts', t('settings.storage.artifacts'), data.breakdown.artifacts, true],
            ] as const
          ).map(([kind, label, share, artifacts]) => (
            <div key={kind} className="flex items-baseline justify-between gap-2 sm:block">
              <dt className="text-[var(--text-secondary)]">{label}</dt>
              <dd className="text-[var(--text-muted)]">
                {t('settings.storage.kindSummary', {
                  bytes: formatBytes(share.bytes),
                  items: t(
                    artifacts ? 'settings.storage.artifactCount' : 'settings.storage.files',
                    { count: share.count },
                  ),
                })}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-2 text-[var(--text-muted)] text-xs">
        {hasByteLimit
          ? nearlyFull
            ? t('settings.storage.nearlyFull')
            : t('settings.storage.free', {
                size: formatBytes(Math.max(0, (data.maxTotalBytes as number) - data.liveBytes)),
              })
          : t('settings.storage.noLimit')}
        {/* Files you deleted (gone for good, only waiting to be removed from
            storage) and those of conversations in the trash. There is no trash
            for files, so this does not say they are in one (#179). With no
            limit, it does not speak of one (#254). */}
        {data.pendingFileCount > 0 &&
          ` ${t(
            hasLimit ? 'settings.storage.pendingWithLimit' : 'settings.storage.pendingNoLimit',
            { size: formatBytes(data.pendingBytes) },
          )}`}
      </p>
    </div>
  );
}
