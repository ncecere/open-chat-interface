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
  return text.length > 70 ? `${text.slice(0, 70).trimEnd()}…` : text || '(no text)';
}

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

function statusOf(link: OwnerShareLink): 'active' | 'expired' | 'revoked' {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

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
  const status = statusOf(link);
  const url = shareUrl(link.slug);
  // Copying is reading; revoking is a change, off while read-only (#331).
  const lock = useReadOnlyLock();

  return (
    <li className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/45 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={status === 'active' ? 'success' : 'neutral'} className="capitalize">
              {status}
            </Badge>
            <span className="text-xs text-[var(--text-muted)]">
              {link.upToMessageId ? 'Snapshot' : 'Live'} · {link.viewCount}{' '}
              {link.viewCount === 1 ? 'view' : 'views'}
            </span>
          </div>
          {/* The whole link on hover; the field is narrower than most links (#130). */}
          <p
            className="mt-2 truncate font-mono text-xs text-[var(--text-secondary)]"
            title={url ?? 'Invalid share URL'}
          >
            {url ?? 'Invalid share URL'}
          </p>
          <p className="mt-1 text-[0.6875rem] text-[var(--text-muted)]">
            Created {formatDate(link.createdAt)}
            {link.expiresAt ? ` · Expires ${formatDate(link.expiresAt)}` : ' · No expiration'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Copy share link"
            disabled={!url || status !== 'active'}
            onClick={onCopy}
          >
            {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Revoke share link"
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
  const [open, setOpen] = useState(false);
  const [cutoffId, setCutoffId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
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
      api.post<{ link: OwnerShareLink }>(
        `/share-links/threads/${encodeURIComponent(threadId)}`,
        body,
      ),
    onSuccess: async (response) => {
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
      setCopyError('The server returned an invalid share URL.');
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
      setCopyError('Clipboard access failed. Select the URL and copy it manually.');
    }
  }

  function submit() {
    setFormError(null);
    create.reset();

    let expiration: string | null = null;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        setFormError('Choose an expiration time in the future.');
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
            aria-label="Share conversation"
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
          <DialogTitle>Share conversation</DialogTitle>
          <DialogDescription>
            Anyone with an active link can read the shared messages. Attachments and private model
            reasoning are never included.
          </DialogDescription>
        </DialogHeader>

        <section className="grid gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/30 p-4 sm:grid-cols-2">
          <Field
            label="Share through"
            htmlFor="share-cutoff"
            hint="Choose a message for a fixed snapshot, or keep the conversation live."
          >
            <Select
              id="share-cutoff"
              value={cutoffId}
              disabled={messages.isLoading || create.isPending}
              onChange={setCutoffId}
              options={[
                { value: '', label: 'Latest messages (live)' },
                ...publicMessages.map((message, index) => ({
                  value: message.id,
                  label: `${index + 1}. ${message.role === 'user' ? 'You' : 'Assistant'}: ${textPreview(message)}`,
                })),
              ]}
            />
          </Field>

          <Field
            label="Expires (optional)"
            htmlFor="share-expiration"
            hint="Uses your local time. Leave blank for no expiration."
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
            <p className="text-xs text-[var(--text-muted)]">
              Existing links are independent; creating a new link does not revoke them.
            </p>
            <Button
              type="button"
              variant="primary"
              locked={lock.title}
              disabled={create.isPending}
              onClick={submit}
            >
              {create.isPending ? <Spinner /> : <Link2 />}
              Create and copy link
            </Button>
          </div>
        </section>

        {(formError || create.error) && (
          <p
            className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
            role="alert"
          >
            {formError ?? apiErrorMessage(create.error, 'Failed to create share link.')}
          </p>
        )}
        {copyError && (
          <p className="mt-3 text-xs text-[var(--warning)]" role="status">
            {copyError}
          </p>
        )}

        <section className="mt-6" aria-labelledby="existing-share-links">
          <h3 id="existing-share-links" className="text-sm font-semibold">
            Existing links
          </h3>

          {(links.isLoading || messages.isLoading) && (
            <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
              <Spinner /> Loading share settings…
            </div>
          )}
          {loadError && (
            <p
              className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
              role="alert"
            >
              {apiErrorMessage(loadError, 'Failed to load share links.')}
            </p>
          )}
          {links.data?.links.length === 0 && (
            <p className="mt-3 rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
              No share links yet.
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
          title="Revoke this link?"
          description={
            <>
              The link stops working at once. Anyone who opened it before keeps what they saved or
              copied. A revoked link cannot be turned back on; you can make a new one here.
            </>
          }
          confirmLabel="Revoke link"
          pendingLabel="Revoking…"
          errorMessage="The link could not be revoked."
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
