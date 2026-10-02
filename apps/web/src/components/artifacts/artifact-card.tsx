import { ARTIFACT_KIND_LABELS, type ArtifactKind } from '@oci/shared';
import { ChevronRight, FileCode2, FileImage, FileText, Workflow } from 'lucide-react';
import type { ArtifactRef } from '~/components/artifacts/artifacts-context';

const ARTIFACT_ICONS: Record<ArtifactKind, typeof FileCode2> = {
  html: FileCode2,
  svg: FileImage,
  mermaid: Workflow,
  markdown: FileText,
};

/** "HTML · version 2" */
function artifactMeta(artifact: Pick<ArtifactRef, 'kind' | 'version'>): string {
  return `${ARTIFACT_KIND_LABELS[artifact.kind]} · version ${artifact.version}`;
}

/**
 * An artifact in a reply: one button that opens the side panel. Its name
 * says what opens ("Open artifact: Sales chart"), and the panel returns focus
 * here when it closes.
 */
export function ArtifactCard({
  artifact,
  onOpen,
  note,
}: {
  artifact: ArtifactRef;
  onOpen: (artifact: ArtifactRef) => void;
  /** For example "Updated" on a reply that revised an existing artifact. */
  note?: string;
}) {
  const Icon = ARTIFACT_ICONS[artifact.kind];
  return (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      aria-haspopup="dialog"
      aria-label={`Open artifact: ${artifact.title}`}
      data-artifact-card={artifact.sourceKey}
      className="my-3 flex w-full max-w-md items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/50 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
        <Icon className="size-4 text-[var(--text-secondary)]" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
          {artifact.title}
        </span>
        <span className="block text-xs text-[var(--text-muted)]">
          {note ? `${note} · ` : ''}
          {artifactMeta(artifact)}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
    </button>
  );
}
