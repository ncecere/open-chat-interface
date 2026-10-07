import type { MyShareLink, MyShareLinksResponse } from '@oci/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api, apiErrorMessage } from '~/lib/api-client';

const MY_SHARE_LINKS_KEY = ['me', 'share-links'] as const;

type Status = 'active' | 'expired' | 'revoked';

function statusOf(link: MyShareLink, now = Date.now()): Status {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

const STATUS_LABELS: Record<Status, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
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
  const status = statusOf(link);
  const title = link.threadTitle || 'Untitled conversation';
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
            {STATUS_LABELS[status]}
          </Badge>
          <Badge variant="neutral">{link.upToMessageId ? 'Snapshot' : 'Live'}</Badge>
          {link.threadUnavailable && (
            <span className="text-xs text-[var(--text-muted)]">
              Conversation in the trash or expired
            </span>
          )}
        </div>
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">
          Created {formatDate(link.createdAt)} ·{' '}
          {link.expiresAt
            ? `${status === 'expired' ? 'Expired' : 'Expires'} ${formatDate(link.expiresAt)}`
            : 'No expiration'}{' '}
          · {link.viewCount} {link.viewCount === 1 ? 'view' : 'views'}
          {link.revokedAt ? ` · Revoked ${formatDate(link.revokedAt)}` : ''}
        </p>
      </div>
      {status !== 'revoked' && (
        <div className="flex shrink-0 items-center gap-2">
          {status === 'active' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Copy the link to ${title}`}
              onClick={onCopy}
            >
              {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={`Revoke the link to ${title}`}
            onClick={onRevoke}
          >
            Revoke
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
  const queryClient = useQueryClient();
  const { data: me } = useCurrentUser();
  const [revoking, setRevoking] = useState<MyShareLink | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

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
      setNotice('The link could not be copied. Open the conversation to copy it from there.');
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Sharing</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Every public link you have made to a conversation. Anybody with a link can read what it
        shows, without an account. Revoking a link makes it stop working at once.
      </p>

      {sharingOff && (
        <p
          role="note"
          className="mt-6 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-sm text-[var(--text-secondary)]"
        >
          Making new share links is turned off for your account. You can still revoke the links you
          made before.
        </p>
      )}

      {links.isLoading ? (
        <div className="py-16" role="status" aria-label="Loading share links">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : links.isError ? (
        <p role="alert" className="mt-8 text-sm text-[var(--danger)]">
          {apiErrorMessage(links.error, 'Your share links could not be loaded. Try again.')}
        </p>
      ) : list.length === 0 ? (
        <p className="mt-10 text-sm text-[var(--text-muted)]">
          {/* No instructions for something this account cannot do (#99). */}
          {sharingOff
            ? 'You have no share links.'
            : 'You have not shared any conversations. To share one, open it and choose Share conversation.'}
        </p>
      ) : (
        <section className="mt-8" aria-labelledby="share-links-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="share-links-heading" className="text-xl font-bold">
              Your shared links
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-sm text-[var(--text-muted)]">
                {active} of {first?.total ?? 0} not revoked
              </span>
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={active === 0}
                onClick={() => setRevokingAll(true)}
              >
                Revoke all
              </Button>
            </div>
          </div>
          <p role="status" aria-live="polite" className="mt-2 text-xs text-[var(--text-muted)]">
            {notice}
          </p>
          <ul aria-label="Your shared links" className="mt-2 flex flex-col">
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
                Show more
              </Button>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke this link?"
        description={
          <>
            The link to {revoking?.threadTitle || 'this conversation'} stops working at once. Anyone
            who opened it before keeps what they saved or copied. A revoked link cannot be turned
            back on; you can make a new one from the conversation.
          </>
        }
        confirmLabel="Revoke link"
        pendingLabel="Revoking…"
        errorMessage="The link could not be revoked."
        onConfirm={async () => {
          if (!revoking) return;
          await api.delete(`/share-links/links/${encodeURIComponent(revoking.id)}`);
          setNotice('The link has been revoked.');
          await refresh();
        }}
      />

      <ConfirmDialog
        open={revokingAll}
        onOpenChange={setRevokingAll}
        title={active === 1 ? 'Revoke your share link?' : `Revoke all ${active} share links?`}
        description={
          <>
            Every link you have made stops working at once, including links that have expired, so
            none can work again. Anyone who opened them before keeps what they saved or copied. This
            cannot be undone.
          </>
        }
        confirmLabel="Revoke all"
        pendingLabel="Revoking…"
        errorMessage="Your links could not be revoked."
        onConfirm={async () => {
          const result = await api.post<{ revoked: number }>('/me/share-links/revoke-all');
          setNotice(
            result.revoked === 1
              ? '1 link has been revoked.'
              : `${result.revoked} links have been revoked.`,
          );
          await refresh();
        }}
      />
    </div>
  );
}
