import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Share2, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { api, apiErrorMessage } from '~/lib/api-client';
import { formatDate as formatDateTime, translate, useT } from '~/lib/i18n';
import { useReadOnlyLock } from '~/lib/read-only';

interface OwnerShareLink {
  id: string;
  slug: string;
  path: string;
  upToMessageId: string | null;
  viewCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /**
   * Not readable while the conversation carries a data class (v0.14, #395);
   * it works again once the label is gone.
   */
  paused?: boolean;
}

interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<Record<string, unknown>>;
}

function textPreview(message: ThreadMessage): string {
  const text = message.parts
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 70
    ? `${text.slice(0, 70).trimEnd()}…`
    : text || translate('chat.share.noText');
}

function formatDate(value: string): string {
  if (Number.isNaN(new Date(value).getTime())) return translate('chat.share.unknownDate');
  return formatDateTime(value, 'dateTime');
}

function shareUrl(slug: string): string | null {
  if (!/^[A-Za-z0-9_-]{32}$/.test(slug)) return null;
  return new URL(`/share/${encodeURIComponent(slug)}`, window.location.origin).toString();
}

function statusOf(link: OwnerShareLink): 'active' | 'expired' | 'revoked' {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

const STATUS_KEYS = {
  active: 'chat.share.statusActive',
  expired: 'chat.share.statusExpired',
  revoked: 'chat.share.statusRevoked',
} as const;

function ShareLinkRow({
  link,
  copied,
  onCopy,
  onRevoke,
}: {
  link: OwnerShareLink;
  copied: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  const t = useT();
  const status = statusOf(link);
  const paused = Boolean(link.paused) && status === 'active';
  const url = shareUrl(link.slug);
  // Copying is reading; revoking is a change, off while read-only (#331).
  const lock = useReadOnlyLock();

  return (
    <li className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/45 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={paused ? 'warning' : status === 'active' ? 'success' : 'neutral'}
              className="capitalize"
            >
              {paused ? t('chat.share.statusPaused') : t(STATUS_KEYS[status])}
            </Badge>
            <span className="text-xs text-[var(--text-muted)]">
              {t(link.upToMessageId ? 'chat.share.metaSnapshot' : 'chat.share.metaLive', {
                count: link.viewCount,
              })}
            </span>
          </div>
          {/* The whole link on hover; the field is narrower than most links (#130). */}
          <p
            className="mt-2 truncate font-mono text-xs text-[var(--text-secondary)]"
            title={url ?? t('chat.share.invalidUrl')}
          >
            {url ?? t('chat.share.invalidUrl')}
          </p>
          <p className="mt-1 text-[0.6875rem] text-[var(--text-muted)]">
            {link.expiresAt
              ? t('chat.share.createdExpires', {
                  created: formatDate(link.createdAt),
                  expires: formatDate(link.expiresAt),
                })
              : t('chat.share.createdNoExpiry', { created: formatDate(link.createdAt) })}
          </p>
          {paused && (
            <p className="mt-1 text-xs text-[var(--text-secondary)]" data-share-paused>
              {t('chat.share.pausedNote')}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('chat.share.copyLink')}
            disabled={!url || status !== 'active' || paused}
            onClick={onCopy}
          >
            {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('chat.share.revokeLink')}
            aria-haspopup="dialog"
            locked={lock.title}
            disabled={status === 'revoked'}
            onClick={onRevoke}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * Self-contained owner control. Mount it only when the current user's effective
 * `features.shareLinks` permission is true.
 */
export function ShareThreadDialog({
  threadId,
  trigger,
}: {
  threadId: string;
  trigger?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [cutoffId, setCutoffId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // Said when the link was made in warn mode for a conversation that carries a class (v0.14, #395).
  const [notice, setNotice] = useState<string | null>(null);
  // Revoking asks first, as Settings → Sharing does (#252): one click beside
  // Copy took down a link already sent out, and it cannot be turned back on.
  const [revoking, setRevoking] = useState<OwnerShareLink | null>(null);
  const queryClient = useQueryClient();
  const linksKey = ['share-links', threadId] as const;
  // Making a link is a change: off while read-only, with the reason, as the
  // sidebar's Rename is (#331). Existing links stay listed in Settings → Sharing.
  const lock = useReadOnlyLock();

  const links = useQuery({
    queryKey: linksKey,
    queryFn: () =>
      api.get<{ links: OwnerShareLink[] }>(`/share-links/threads/${encodeURIComponent(threadId)}`),
    enabled: open,
  });

  const messages = useQuery({
    queryKey: ['thread', threadId, 'share-message-options'],
    queryFn: () =>
      api.get<{ messages: ThreadMessage[] }>(`/chat/${encodeURIComponent(threadId)}/messages`),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: (body: { upToMessageId: string | null; expiresAt: string | null }) =>
      api.post<{ link: OwnerShareLink; notice?: string }>(
        `/share-links/threads/${encodeURIComponent(threadId)}`,
        body,
      ),
    onSuccess: async (response) => {
      setNotice(response.notice ?? null);
      setCutoffId('');
      setExpiresAt('');
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: linksKey });
      await copyLink(response.link);
    },
  });

  async function copyLink(link: OwnerShareLink) {
    const url = shareUrl(link.slug);
    if (!url) {
      setCopyError(t('chat.share.serverInvalidUrl'));
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(link.id);
      setCopyError(null);
      window.setTimeout(
        () => setCopiedId((current) => (current === link.id ? null : current)),
        1500,
      );
    } catch {
      setCopyError(t('chat.share.clipboardFailed'));
    }
  }

  function submit() {
    setFormError(null);
    setNotice(null);
    create.reset();

    let expiration: string | null = null;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        setFormError(t('chat.share.expiryPast'));
        return;
      }
      expiration = parsed.toISOString();
    }

    create.mutate({ upToMessageId: cutoffId || null, expiresAt: expiration });
  }

  const publicMessages =
    messages.data?.messages.filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    ) ?? [];
  const loadError = links.error ?? messages.error;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('chat.share.open')}
            locked={lock.title}
          >
            <Share2 />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-h-[min(48rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto"
        // "Share through" is disabled while the messages load, which is when
        // the dialog opens, so Radix put focus on the first field it could:
        // Expires, the second, which on touch devices can open its picker at
        // once. Start at Share through when it is ready, else on the dialog,
        // so Tab follows the visual order from the top (#158).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const first = document.getElementById('share-cutoff');
          if (first && !first.hasAttribute('disabled')) first.focus();
          else (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('chat.share.open')}</DialogTitle>
          <DialogDescription>{t('chat.share.description')}</DialogDescription>
        </DialogHeader>

        <section className="grid gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/30 p-4 sm:grid-cols-2">
          <Field
            label={t('chat.share.throughLabel')}
            htmlFor="share-cutoff"
            hint={t('chat.share.throughHint')}
          >
            <Select
              id="share-cutoff"
              value={cutoffId}
              disabled={messages.isLoading || create.isPending}
              onChange={setCutoffId}
              options={[
                { value: '', label: t('chat.share.optionLive') },
                ...publicMessages.map((message, index) => ({
                  value: message.id,
                  label: t(
                    message.role === 'user' ? 'chat.share.optionYou' : 'chat.share.optionAssistant',
                    {
                      index: index + 1,
                      preview: textPreview(message),
                    },
                  ),
                })),
              ]}
            />
          </Field>

          <Field
            label={t('chat.share.expiresLabel')}
            htmlFor="share-expiration"
            hint={t('chat.share.expiresHint')}
          >
            <Input
              id="share-expiration"
              type="datetime-local"
              value={expiresAt}
              disabled={create.isPending}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>

          <div className="flex flex-col items-stretch gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-[var(--text-muted)]">{t('chat.share.independent')}</p>
            <Button
              type="button"
              variant="primary"
              locked={lock.title}
              disabled={create.isPending}
              onClick={submit}
            >
              {create.isPending ? <Spinner /> : <Link2 />}
              {t('chat.share.create')}
            </Button>
          </div>
        </section>

        {(formError || create.error) && (
          <p
            className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
            role="alert"
          >
            {formError ?? apiErrorMessage(create.error, t('chat.share.createFailed'))}
          </p>
        )}
        {notice && (
          <p
            className="mt-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--text-secondary)]"
            role="status"
            data-share-notice
          >
            {notice}
          </p>
        )}
        {copyError && (
          <p className="mt-3 text-xs text-[var(--warning)]" role="status">
            {copyError}
          </p>
        )}

        <section className="mt-6" aria-labelledby="existing-share-links">
          <h3 id="existing-share-links" className="text-sm font-semibold">
            {t('chat.share.existing')}
          </h3>

          {(links.isLoading || messages.isLoading) && (
            <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
              <Spinner /> {t('chat.share.loading')}
            </div>
          )}
          {loadError && (
            <p
              className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
              role="alert"
            >
              {apiErrorMessage(loadError, t('chat.share.loadFailed'))}
            </p>
          )}
          {links.data?.links.length === 0 && (
            <p className="mt-3 rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
              {t('chat.share.none')}
            </p>
          )}
          {links.data && links.data.links.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {links.data.links.map((link) => (
                <ShareLinkRow
                  key={link.id}
                  link={link}
                  copied={copiedId === link.id}
                  onCopy={() => void copyLink(link)}
                  onRevoke={() => setRevoking(link)}
                />
              ))}
            </ul>
          )}
        </section>

        <ConfirmDialog
          open={revoking !== null}
          onOpenChange={(next) => {
            if (!next) setRevoking(null);
          }}
          title={t('chat.share.revokeTitle')}
          description={t('chat.share.revokeDescription')}
          confirmLabel={t('chat.share.revokeConfirm')}
          pendingLabel={t('chat.share.revoking')}
          errorMessage={t('chat.share.revokeFailed')}
          onConfirm={async () => {
            if (!revoking) return;
            await api.delete(`/share-links/links/${encodeURIComponent(revoking.id)}`);
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: linksKey }),
              // Settings → Sharing lists it too.
              queryClient.invalidateQueries({ queryKey: ['me', 'share-links'] }),
            ]);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
