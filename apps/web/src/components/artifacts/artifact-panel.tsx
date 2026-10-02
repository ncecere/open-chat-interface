import {
  ARTIFACT_FILE_TYPES,
  ARTIFACT_KIND_LABELS,
  type ArtifactDetail,
  type ArtifactVersionDetail,
  type DocumentFormat,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, Pencil } from 'lucide-react';
import { type KeyboardEvent, useCallback, useId, useState } from 'react';
import { ArtifactFrame } from '~/components/artifacts/artifact-frame';
import { type ArtifactRef, useArtifacts } from '~/components/artifacts/artifacts-context';
import { ExportMenu, ExportNotice, useDocumentExport } from '~/components/chat/export-menu';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { PillTabs } from '~/components/ui/pill-tabs';
import { ApiError, api, saveBlob } from '~/lib/api-client';
import { cn } from '~/lib/utils';

type View = 'preview' | 'source' | 'versions';

/** The title made safe for a file name, without an extension. */
function filenameBase(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .toLowerCase() || 'artifact'
  );
}

/** A file name for a download: the title, made safe, with the kind's extension. */
export function artifactFilename(title: string, kind: ArtifactRef['kind']): string {
  return `${filenameBase(title)}.${ARTIFACT_FILE_TYPES[kind].extension}`;
}

function download(title: string, kind: ArtifactRef['kind'], content: string) {
  const blob = new Blob([content], { type: `${ARTIFACT_FILE_TYPES[kind].mimeType};charset=utf-8` });
  saveBlob(blob, artifactFilename(title, kind));
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * The artifact side panel: a modal dialog on the right (full screen on
 * phones) with Preview, Source and, for the owner, Versions. Escape closes it
 * (or first leaves an unsaved edit) and focus returns to the card that opened
 * it.
 */
export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: ArtifactRef | null;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <Dialog
      open={artifact !== null}
      onOpenChange={(open) => {
        if (!open) {
          setEditing(false);
          onClose();
        }
      }}
    >
      {artifact && (
        <DialogContent
          data-artifact-panel=""
          onEscapeKeyDown={(event) => {
            // Escape leaves an edit first; a second one closes the panel.
            if (editing) {
              event.preventDefault();
              setEditing(false);
            }
          }}
          className={cn(
            'flex flex-col gap-0 overflow-hidden p-0',
            // Phones: the whole screen. Wider screens: a panel on the right.
            'inset-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none',
            'md:left-auto md:right-0 md:w-[min(56rem,92vw)] md:rounded-none md:border-y-0 md:border-r-0',
          )}
        >
          <ArtifactPanelBody
            key={artifact.id ?? `${artifact.messageId}:${artifact.sourceKey}`}
            artifact={artifact}
            editing={editing}
            setEditing={setEditing}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ArtifactPanelBody({
  artifact,
  editing,
  setEditing,
}: {
  artifact: ArtifactRef;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const context = useArtifacts();
  const owner = context?.mode === 'owner' && artifact.id !== null;
  const id = artifact.id ?? '';
  const [view, setView] = useState<View>('preview');
  const [selected, setSelected] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const viewId = useId();

  const detail = useQuery({
    queryKey: ['artifact', id],
    queryFn: ({ signal }) =>
      api.get<ArtifactDetail>(`/artifacts/${encodeURIComponent(id)}`, { signal }),
    enabled: owner,
  });
  const current = detail.data?.artifact.currentVersion ?? artifact.version;
  const older = selected !== null && selected !== current ? selected : null;
  const version = useQuery({
    queryKey: ['artifact', id, 'version', older],
    queryFn: ({ signal }) =>
      api.get<ArtifactVersionDetail>(`/artifacts/${encodeURIComponent(id)}/versions/${older}`, {
        signal,
      }),
    enabled: owner && older !== null,
  });

  const title = detail.data?.artifact.title ?? artifact.title;
  const shownVersion = older ?? current;
  const content = !owner
    ? (artifact.content ?? '')
    : older !== null
      ? version.data?.content
      : detail.data?.content;
  const loading = owner && (older !== null ? version.isLoading : detail.isLoading);
  const loadError = owner && (older !== null ? version.isError : detail.isError);
  const canEdit =
    owner && Boolean(context?.canEdit) && artifact.kind === 'markdown' && older === null;
  // File output: the API turns Markdown documents into files; other kinds are
  // downloaded as they are. Owners only (never on a share page).
  const canExport = owner && artifact.kind === 'markdown';
  const exportPath = useCallback(
    (format: DocumentFormat) =>
      `/artifacts/${encodeURIComponent(id)}/export?format=${format}${
        older !== null ? `&version=${older}` : ''
      }`,
    [id, older],
  );
  const exporting = useDocumentExport(exportPath, filenameBase(title));

  const tabs = [
    { id: 'preview' as const, label: 'Preview' },
    { id: 'source' as const, label: 'Source' },
    ...(owner ? [{ id: 'versions' as const, label: 'Versions' }] : []),
  ];

  async function copy() {
    if (content === undefined) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <>
      <header className="flex flex-wrap items-start gap-3 border-b border-[var(--border-subtle)] px-4 py-3 pr-14 sm:px-5">
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-base">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            {ARTIFACT_KIND_LABELS[artifact.kind]} · version {shownVersion}
            {older !== null ? ` of ${current}` : ''}
          </DialogDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Artifact">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void copy()}
            disabled={content === undefined}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => content !== undefined && download(title, artifact.kind, content)}
            disabled={content === undefined}
          >
            <Download aria-hidden="true" />
            Download
          </Button>
          {canExport && (
            <ExportMenu
              markdown={content ?? ''}
              state={exporting}
              disabled={content === undefined || editing}
            />
          )}
          {canEdit && !editing && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              disabled={content === undefined}
            >
              <Pencil aria-hidden="true" />
              Edit
            </Button>
          )}
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {copied ? 'Copied to the clipboard' : ''}
        </span>
        {canExport && <ExportNotice state={exporting} className="basis-full" />}
      </header>

      {editing && canEdit && content !== undefined ? (
        <DocumentEditor
          artifactId={id}
          initial={content}
          baseVersion={current}
          onDone={() => {
            setEditing(false);
            setSelected(null);
            setView('preview');
          }}
        />
      ) : (
        <>
          <div className="border-b border-[var(--border-subtle)] px-4 py-2 sm:px-5">
            <PillTabs tabs={tabs} active={view} onChange={setView} label="View" controls={viewId} />
          </div>
          <section
            id={viewId}
            role="tabpanel"
            aria-label={tabs.find((tab) => tab.id === view)?.label}
            className="min-h-0 flex-1 overflow-auto"
          >
            {view === 'versions' ? (
              <VersionList
                detail={detail.data}
                selected={shownVersion}
                onSelect={(next) => {
                  setSelected(next === current ? null : next);
                  setView('preview');
                }}
              />
            ) : loading ? (
              <p role="status" className="p-4 text-sm text-[var(--text-muted)]">
                Loading…
              </p>
            ) : loadError || content === undefined ? (
              <p role="alert" className="p-4 text-sm text-[var(--danger-foreground)]">
                This artifact could not be loaded.
              </p>
            ) : view === 'source' ? (
              <pre className="m-0 min-h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-[var(--text-secondary)] sm:p-5">
                <code>{content}</code>
              </pre>
            ) : (
              <ArtifactPreview
                kind={artifact.kind}
                content={content}
                title={title}
                markdownProps={context?.markdownProps}
              />
            )}
          </section>
        </>
      )}
    </>
  );
}

/** The rendered artifact: sandboxed for HTML and SVG, OCI's Markdown renderer otherwise. */
export function ArtifactPreview({
  kind,
  content,
  title,
  markdownProps,
}: {
  kind: ArtifactRef['kind'];
  content: string;
  title: string;
  markdownProps?: {
    skipHtml?: boolean;
    urlTransform?: (value: string, key: string, node: unknown) => string | null;
  };
}) {
  if (kind === 'html' || kind === 'svg')
    return (
      <ArtifactFrame
        kind={kind}
        content={content}
        title={`${title} (preview)`}
        className="min-h-[60vh]"
      />
    );
  const markdown = kind === 'mermaid' ? `\`\`\`mermaid\n${content}\n\`\`\`` : content;
  return (
    <div className="p-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] sm:p-5">
      <Markdown className={MARKDOWN_PROSE} {...markdownProps}>
        {markdown}
      </Markdown>
    </div>
  );
}

function VersionList({
  detail,
  selected,
  onSelect,
}: {
  detail: ArtifactDetail | undefined;
  selected: number;
  onSelect: (version: number) => void;
}) {
  if (!detail)
    return (
      <p role="status" className="p-4 text-sm text-[var(--text-muted)]">
        Loading…
      </p>
    );
  return (
    <ol className="divide-y divide-[var(--border-subtle)]" aria-label="Versions, newest first">
      {detail.versions.map((entry) => (
        <li key={entry.version}>
          <button
            type="button"
            onClick={() => onSelect(entry.version)}
            aria-current={entry.version === selected ? 'true' : undefined}
            className={cn(
              'flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-[var(--bg-control)] sm:px-5',
              entry.version === selected && 'bg-[var(--bg-control)]',
            )}
          >
            <span className="font-medium text-[var(--text-primary)]">
              Version {entry.version}
              {entry.version === detail.artifact.currentVersion ? ' (current)' : ''}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {entry.source === 'person' ? 'Edited by you' : 'By the assistant'} ·{' '}
              {formatDate(entry.createdAt)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Editing a Markdown document: saving makes a new version; nothing is overwritten. */
function DocumentEditor({
  artifactId,
  initial,
  baseVersion,
  onDone,
}: {
  artifactId: string;
  initial: string;
  baseVersion: number;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const editorId = useId();
  const save = useMutation({
    mutationFn: () =>
      api.post(`/artifacts/${encodeURIComponent(artifactId)}/versions`, {
        content: draft,
        baseVersion,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] }),
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
      ]);
      onDone();
    },
  });
  const unchanged = draft === initial;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !unchanged && draft.trim()) {
      event.preventDefault();
      save.mutate();
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged && draft.trim()) save.mutate();
      }}
    >
      <label htmlFor={editorId} className="text-sm font-medium text-[var(--text-primary)]">
        Edit document
      </label>
      <textarea
        id={editorId}
        // biome-ignore lint/a11y/noAutofocus: the person chose to edit; focus belongs in the editor.
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck
        className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--border-strong)] bg-[var(--bg-control)] p-3 font-mono text-sm leading-relaxed text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent-bright)]"
      />
      {save.error && (
        <p role="alert" className="text-sm text-[var(--danger-foreground)]">
          {save.error instanceof ApiError ? save.error.message : 'The document could not be saved.'}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={unchanged || !draft.trim() || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save as new version'}
        </Button>
      </div>
    </form>
  );
}
