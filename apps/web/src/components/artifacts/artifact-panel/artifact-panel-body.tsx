import {
  type ArtifactDetail,
  type ArtifactVersionDetail,
  artifactKindLabel,
  type DocumentFormat,
} from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Download, Pencil } from 'lucide-react';
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArtifactSource } from '~/components/artifacts/artifact-source';
import { type ArtifactRef, useArtifacts } from '~/components/artifacts/artifacts-context';
import { ExportMenu, ExportNotice, useDocumentExport } from '~/components/chat/export-menu';
import { Button } from '~/components/ui/button';
import { PillTabs } from '~/components/ui/pill-tabs';
import { api } from '~/lib/api-client';
import { returnFocusIfLost } from '~/lib/focus-return';
import { useReadOnlyLock } from '~/lib/read-only';
import { ArtifactPreview } from './artifact-preview';
import { DocumentEditor } from './document-editor';
import { type Chrome, PanelHeader } from './panel-header';
import { download, filenameBase, type View } from './panel-helpers';
import { VersionList } from './version-list';

export function ArtifactPanelBody({
  artifact,
  editing,
  setEditing,
  chrome,
}: {
  artifact: ArtifactRef;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  chrome: Chrome;
}) {
  const context = useArtifacts();
  const owner = context?.mode === 'owner' && artifact.id !== null;
  const id = artifact.id ?? '';
  const [view, setView] = useState<View>('preview');
  const [selected, setSelected] = useState<number | null>(artifact.openVersion ?? null);
  const [copied, setCopied] = useState(false);
  const viewId = useId();
  // Saving a version is a change: Edit is off while read-only (#331).
  const lock = useReadOnlyLock();

  // Edit and the editor replace each other. The editor takes focus on open;
  // when it closes (Cancel, Save or Escape) the button that opened it gets it
  // back rather than the page (#333).
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(editing);
  useLayoutEffect(() => {
    const closed = wasEditing.current && !editing;
    wasEditing.current = editing;
    if (closed) returnFocusIfLost(editButton.current);
  }, [editing]);

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
      <PanelHeader
        chrome={chrome}
        title={title}
        description={
          <>
            {artifactKindLabel(artifact.kind, artifact.language)} · version {shownVersion}
            {older !== null ? ` of ${current}` : ''}
          </>
        }
        toolbar={
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
              onClick={() =>
                content !== undefined && download(title, artifact.kind, content, artifact.language)
              }
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
                ref={editButton}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                title={lock.title}
                disabled={content === undefined || lock.locked}
              >
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            )}
          </div>
        }
      >
        <span className="sr-only" role="status" aria-live="polite">
          {copied ? 'Copied to the clipboard' : ''}
        </span>
        {canExport && <ExportNotice state={exporting} className="basis-full" />}
      </PanelHeader>

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
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a long source scrolls; the keyboard must reach it.
            tabIndex={0}
            className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
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
              <p role="alert" className="p-4 text-sm text-[var(--danger-on-tint)]">
                This artifact could not be loaded.
              </p>
            ) : view === 'source' ? (
              <ArtifactSource kind={artifact.kind} language={artifact.language} content={content} />
            ) : (
              <ArtifactPreview
                kind={artifact.kind}
                language={artifact.language}
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
