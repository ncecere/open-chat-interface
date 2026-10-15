import type { MyShareLink, MyShareLinksResponse } from '@oci/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { SettingsConfirmDialog } from '~/components/settings/confirm-dialog';
import { tWithUserText } from '~/components/settings/user-text';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api, apiErrorMessage } from '~/lib/api-client';
import { formatDate as formatDateStyle, type MessageKey, translate, useT } from '~/lib/i18n';
import { toDate } from '~/lib/i18n/format';
import { useReadOnlyLock } from '~/lib/read-only';

const MY_SHARE_LINKS_KEY = ['me', 'share-links'] as const;

type Status = 'active' | 'expired' | 'revoked';

function statusOf(link: MyShareLink, now = Date.now()): Status {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

const STATUS_LABELS: Record<Status, MessageKey> = {
  active: 'settings.sharing.statusActive',
  expired: 'settings.sharing.statusExpired',
  revoked: 'settings.sharing.statusRevoked',
};

function formatDate(value: string): string {
  return toDate(value) ? formatDateStyle(value, 'dateTime') : translate('settings.sharing.unknown');
}

function shareUrl(slug: string): string | null {
  if (!/^[A-Za-z0-9_-]{32}$/.test(slug)) return null;
  return new URL(`/share/${encodeURIComponent(slug)}`, window.location.origin).toString();
}

function ShareLinkRow({
  link,
  copied,
  onCopy,
  onRevoke,
}: {
  link: MyShareLink;
  copied: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  const t = useT();
  const status = statusOf(link);
  const title = link.threadTitle || t('settings.sharing.untitled');
  // A change, refused while read-only: off, with the reason (#331).
  const lock = useReadOnlyLock();
  return (
    <li
      className="flex flex-col gap-3 border-b border-[var(--border-subtle)] py-4 last:border-0 sm:flex-row sm:items-start"
      data-testid="share-link"
    >
      <div className="min-w-0 flex-1">
        {link.threadUnavailable ? (
          <p className="truncate font-medium text-[var(--text-primary)]" title={title}>
            {title}
          </p>
        ) : (
          <Link
            to="/chat/$threadId"
            params={{ threadId: link.threadId }}
            className="block truncate font-medium text-[var(--text-primary)] underline-offset-2 hover:underline"
            // The full title on hover when a narrow screen cuts it short (#130).
            title={title}
          >
            {title}
          </Link>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Badge variant={status === 'active' ? 'success' : 'neutral'}>
            {t(STATUS_LABELS[status])}
          </Badge>
          <Badge variant="neutral">
            {link.upToMessageId ? t('settings.sharing.snapshot') : t('settings.sharing.live')}
          </Badge>
          {link.threadUnavailable && (
            <span className="text-xs text-[var(--text-muted)]">
              {t('settings.sharing.unavailable')}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">
          {[
            t('settings.sharing.created', { date: formatDate(link.createdAt) }),
            link.expiresAt
              ? t(
                  status === 'expired'
                    ? 'settings.sharing.expiredOn'
                    : 'settings.sharing.expiresOn',
                  { date: formatDate(link.expiresAt) },
                )
              : t('settings.sharing.noExpiration'),
            t('settings.sharing.views', { count: link.viewCount }),
            ...(link.revokedAt
              ? [t('settings.sharing.revokedOn', { date: formatDate(link.revokedAt) })]
              : []),
          ].join(' · ')}
        </p>
      </div>
      {status !== 'revoked' && (
        <div className="flex shrink-0 items-center gap-2">
          {status === 'active' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t('settings.sharing.copyLabel', { title })}
              onClick={onCopy}
            >
              {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
              {copied ? t('settings.sharing.copied') : t('settings.sharing.copy')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={t('settings.sharing.revokeLabel', { title })}
            locked={lock.title}
            onClick={onRevoke}
          >
            {t('settings.sharing.revoke')}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Settings → Sharing (v0.10): every public link the person has made, with
 * Revoke and Revoke all. Shown even when sharing is off for them, so links
 * made earlier can still be taken down.
 */
export function SettingsSharingPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: me } = useCurrentUser();
  const [revoking, setRevoking] = useState<MyShareLink | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const lock = useReadOnlyLock();

  const links = useInfiniteQuery({
    queryKey: MY_SHARE_LINKS_KEY,
    queryFn: ({ pageParam }) =>
      api.get<MyShareLinksResponse>(`/me/share-links${pageParam ? `?offset=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
  });
  const pages = links.data?.pages ?? [];
  const list = pages.flatMap((page) => page.links);
  const first = pages[0];
  const active = first?.active ?? 0;
  const total = first?.total ?? 0;
  const sharingOff = me?.features.shareLinks === false;

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: MY_SHARE_LINKS_KEY }),
      // The share dialog of each conversation, and the Sharing tab's count.
      queryClient.invalidateQueries({ queryKey: ['share-links'] }),
      queryClient.invalidateQueries({ queryKey: ['me'], exact: true }),
    ]);
  }

  async function copy(link: MyShareLink) {
    const url = shareUrl(link.slug);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(link.id);
      window.setTimeout(() => setCopiedId((id) => (id === link.id ? null : id)), 1500);
    } catch {
      setNotice(t('settings.sharing.copyFailed'));
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">{t('settings.sharing.title')}</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{t('settings.sharing.subtitle')}</p>

      {sharingOff && (
        <p
          role="note"
          className="mt-6 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-sm text-[var(--text-secondary)]"
        >
          {t('settings.sharing.off')}
        </p>
      )}

      {links.isLoading ? (
        <div className="py-16" role="status" aria-label={t('settings.sharing.loading')}>
          <Spinner className="mx-auto size-6" />
        </div>
      ) : links.isError ? (
        <p role="alert" className="mt-8 text-sm text-[var(--danger)]">
          {apiErrorMessage(links.error, t('settings.sharing.loadFailed'))}
        </p>
      ) : list.length === 0 ? (
        <p className="mt-10 text-sm text-[var(--text-muted)]">
          {/* No instructions for something this account cannot do (#99). */}
          {sharingOff ? t('settings.sharing.noneOff') : t('settings.sharing.none')}
        </p>
      ) : (
        <section className="mt-8" aria-labelledby="share-links-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="share-links-heading" className="text-xl font-bold">
              {t('settings.sharing.listTitle')}
            </h2>
            <div className="flex items-center gap-3">
              {/* Counts without a double negative; "0 of 1 not revoked" (#254).
                  `active` is every link not revoked, expired ones included. */}
              <span className="text-sm text-[var(--text-muted)]">
                {t('settings.sharing.counts', { total, revoked: total - active })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="danger"
                locked={lock.title}
                disabled={active === 0}
                onClick={() => setRevokingAll(true)}
              >
                {t('settings.sharing.revokeAll')}
              </Button>
            </div>
          </div>
          <p role="status" aria-live="polite" className="mt-2 text-xs text-[var(--text-muted)]">
            {notice}
          </p>
          <ul aria-label={t('settings.sharing.listTitle')} className="mt-2 flex flex-col">
            {list.map((link) => (
              <ShareLinkRow
                key={link.id}
                link={link}
                copied={copiedId === link.id}
                onCopy={() => void copy(link)}
                onRevoke={() => setRevoking(link)}
              />
            ))}
          </ul>
          {links.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={links.isFetchingNextPage}
                onClick={() => void links.fetchNextPage()}
              >
                {links.isFetchingNextPage && <Spinner />}
                {t('settings.sharing.showMore')}
              </Button>
            </div>
          )}
        </section>
      )}

      <SettingsConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('settings.sharing.revokeTitle')}
        description={
          // The title quoted, so it does not run into the sentence (#254).
          revoking?.threadTitle
            ? tWithUserText(
                t,
                'settings.sharing.revokeDescriptionNamed',
                { title: revoking.threadTitle },
                ['title'],
              )
            : t('settings.sharing.revokeDescription')
        }
        confirmLabel={t('settings.sharing.revokeConfirm')}
        pendingLabel={t('settings.sharing.revoking')}
        errorMessage={t('settings.sharing.revokeFailed')}
        onConfirm={async () => {
          if (!revoking) return;
          await api.delete(`/share-links/links/${encodeURIComponent(revoking.id)}`);
          setNotice(t('settings.sharing.revoked'));
          await refresh();
        }}
      />

      <SettingsConfirmDialog
        open={revokingAll}
        onOpenChange={setRevokingAll}
        title={t('settings.sharing.revokeAllTitle', { count: active })}
        description={t('settings.sharing.revokeAllDescription')}
        confirmLabel={t('settings.sharing.revokeAll')}
        pendingLabel={t('settings.sharing.revoking')}
        errorMessage={t('settings.sharing.revokeAllFailed')}
        onConfirm={async () => {
          const result = await api.post<{ revoked: number }>('/me/share-links/revoke-all');
          setNotice(t('settings.sharing.revokedMany', { count: result.revoked }));
          await refresh();
        }}
      />
    </div>
  );
}
