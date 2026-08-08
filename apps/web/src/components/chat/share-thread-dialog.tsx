import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Share2, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
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
import { ApiError, api } from '~/lib/api-client';

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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
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
  revoking,
  onCopy,
  onRevoke,
}: {
  link: OwnerShareLink;
  copied: boolean;
  revoking: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  const status = statusOf(link);
  const url = shareUrl(link.slug);

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
          <p className="mt-2 truncate font-mono text-xs text-[var(--text-secondary)]">
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
            disabled={status === 'revoked' || revoking}
            onClick={onRevoke}
          >
            {revoking ? <Spinner /> : <Trash2 />}
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
  const queryClient = useQueryClient();
  const linksKey = ['share-links', threadId] as const;

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

  const revoke = useMutation({
    mutationFn: (linkId: string) =>
      api.delete<{ link: OwnerShareLink }>(`/share-links/links/${encodeURIComponent(linkId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: linksKey }),
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
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Share conversation">
            <Share2 />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[min(48rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto">
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
            <Button type="button" variant="primary" disabled={create.isPending} onClick={submit}>
              {create.isPending ? <Spinner /> : <Link2 />}
              Create and copy link
            </Button>
          </div>
        </section>

        {(formError || create.error) && (
          <p
            className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-foreground)]"
            role="alert"
          >
            {formError ?? errorMessage(create.error, 'Failed to create share link.')}
          </p>
        )}
        {copyError && (
          <p className="mt-3 text-xs text-[var(--warning)]" role="status">
            {copyError}
          </p>
        )}
        {revoke.error && (
          <p
            className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-foreground)]"
            role="alert"
          >
            {errorMessage(revoke.error, 'Failed to revoke share link.')}
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
              className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-foreground)]"
              role="alert"
            >
              {errorMessage(loadError, 'Failed to load share links.')}
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
                  revoking={revoke.isPending && revoke.variables === link.id}
                  onCopy={() => void copyLink(link)}
                  onRevoke={() => revoke.mutate(link.id)}
                />
              ))}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
