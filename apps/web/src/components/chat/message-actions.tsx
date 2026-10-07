import type { DocumentFormat } from '@oci/shared';
import { Check, Copy, GitFork, Globe2, Pencil, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ExportMenu, ExportNotice, useDocumentExport } from '~/components/chat/export-menu';
import { Button } from '~/components/ui/button';
import { useModels } from '~/hooks/use-models';
import { messageExcerpt, quotedMessage } from '~/lib/message-excerpt';
import { readOnlyShortReason, useReadOnlyStatus } from '~/lib/read-only';
import { cn } from '~/lib/utils';

function ModelAttribution({ slug, effort }: { slug: string | null; effort: string | null }) {
  const { data: models } = useModels();
  if (!slug) return null;
  const model = models?.find((entry) => entry.slug === slug);

  return (
    <span className="ml-1 inline-flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-[var(--text-muted)]">
      <span className="max-w-52 truncate">{model?.displayName ?? slug}</span>
      {effort && <span className="capitalize">({effort})</span>}
    </span>
  );
}

/** The reply a file export is made from: a finished assistant message of a saved conversation. */
interface ReplyExportTarget {
  threadId: string;
  messageId: string;
}

function ReplyExport({
  target,
  text,
  about,
}: {
  target: ReplyExportTarget;
  text: string;
  about: string;
}) {
  const { threadId, messageId } = target;
  const pathFor = useCallback(
    (format: DocumentFormat) =>
      `/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/export?format=${format}`,
    [threadId, messageId],
  );
  const state = useDocumentExport(pathFor, 'reply');
  return (
    <>
      <ExportMenu markdown={text} state={state} compact about={about} />
      <ExportNotice state={state} className="order-last basis-full pl-1 pt-1" />
    </>
  );
}

export function MessageActions({
  text,
  onRetry,
  onEdit,
  onFork,
  exportTarget,
  modelSlug,
  effort,
  searched,
  position,
}: {
  text: string;
  onRetry?: () => void;
  onEdit?: () => void;
  onFork?: () => Promise<void>;
  /** Offers "Export as…" (DOCX, PDF, PPTX and, with tables, XLSX). */
  exportTarget?: ReplyExportTarget;
  modelSlug?: string | null;
  effort?: string | null;
  searched?: boolean;
  /** Its place, when another message opens with the same words: "reply 3" (#293). */
  position?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  // Every message has these controls; its opening words tell them apart (#194):
  // "Copy message “Walk3 table: give me a small…”".
  // And "Copy message “Again.” (question 2)" when another opens alike (#293).
  const excerpt = useMemo(() => messageExcerpt(text), [text]);
  const about = excerpt ? ` ${quotedMessage(excerpt, position)}` : '';
  // Read-only maintenance mode (v0.11): forking, editing and retrying write.
  const readOnly = useReadOnlyStatus();
  const lockedTitle = readOnly.active ? readOnlyShortReason(readOnly) : undefined;

  return (
    <div
      className={cn(
        'mt-2 flex min-h-8 flex-wrap items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100',
        // Stay visible while a menu is open (focus is in the portal) or an export reports back.
        'sm:has-[[aria-expanded=true]]:opacity-100 sm:has-[[role=alert]]:opacity-100',
      )}
    >
      {/* Nothing to copy from a reply stopped or failed before its first word (#154). */}
      {text.trim() && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy message${about}`}
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
        </Button>
      )}
      {exportTarget && text.trim() && (
        <ReplyExport target={exportTarget} text={text} about={about} />
      )}
      {onFork && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={excerpt ? `Fork conversation at${about}` : 'Fork conversation here'}
          disabled={readOnly.active}
          title={lockedTitle}
          onClick={() => void onFork()}
        >
          <GitFork />
        </Button>
      )}
      {onEdit && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit message${about}`}
          disabled={readOnly.active}
          title={lockedTitle}
          onClick={onEdit}
        >
          <Pencil />
        </Button>
      )}
      {onRetry && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Retry"
          disabled={readOnly.active}
          title={lockedTitle}
          onClick={onRetry}
        >
          <RefreshCw />
        </Button>
      )}
      {modelSlug && <ModelAttribution slug={modelSlug} effort={effort ?? null} />}
      {searched && (
        <Globe2 className="ml-0.5 size-3.5 text-[var(--text-muted)]" aria-label="Web search used" />
      )}
    </div>
  );
}
