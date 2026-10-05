import { ARTIFACT_FILE_TYPES, type ArtifactKind } from '@oci/shared';
import type { ArtifactDraft } from '~/components/artifacts/artifact-drafts';
import type { ArtifactRef } from '~/components/artifacts/artifacts-context';
import { saveBlob } from '~/lib/api-client';

export type View = 'preview' | 'source' | 'versions';

/** What the panel shows: a saved artifact, or one a reply is writing now. */
export type PanelView =
  | { type: 'artifact'; ref: ArtifactRef }
  | {
      type: 'draft';
      draft: ArtifactDraft;
      title: string | null;
      kind: ArtifactKind | null;
      /** The reply is still writing it (false once saved, failed or stopped). */
      writing: boolean;
    };

/** The title made safe for a file name, without an extension. */
export function filenameBase(title: string): string {
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

export function download(title: string, kind: ArtifactRef['kind'], content: string) {
  const blob = new Blob([content], { type: `${ARTIFACT_FILE_TYPES[kind].mimeType};charset=utf-8` });
  saveBlob(blob, artifactFilename(title, kind));
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export const viewKey = (view: PanelView) =>
  view.type === 'artifact'
    ? `artifact:${view.ref.id ?? `${view.ref.messageId}:${view.ref.sourceKey}`}`
    : `draft:${view.draft.toolCallId}`;
