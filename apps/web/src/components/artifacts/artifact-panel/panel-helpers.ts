import { type ArtifactKind, artifactFileType, safeFileStem } from '@oci/shared';
import type { ArtifactDraft } from '~/components/artifacts/artifact-drafts';
import type { ArtifactRef } from '~/components/artifacts/artifacts-context';
import { saveBlob } from '~/lib/api-client';
import { formatDate as formatDateTime } from '~/lib/i18n';

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

/** The title made safe for a file name, without an extension; every script's letters stay (#361). */
export function filenameBase(title: string): string {
  return safeFileStem(title, 'artifact');
}

/**
 * A file name for a download: the title, made safe, with the kind's extension
 * (a code artifact's language's: `.py`, #298).
 */
export function artifactFilename(
  title: string,
  kind: ArtifactRef['kind'],
  language?: string | null,
): string {
  return `${filenameBase(title)}.${artifactFileType(kind, language).extension}`;
}

export function download(
  title: string,
  kind: ArtifactRef['kind'],
  content: string,
  language?: string | null,
) {
  const type = artifactFileType(kind, language).mimeType;
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  saveBlob(blob, artifactFilename(title, kind, language));
}

export function formatDate(value: string): string {
  return formatDateTime(value, 'dateTime');
}

export const viewKey = (view: PanelView) =>
  view.type === 'artifact'
    ? `artifact:${view.ref.id ?? `${view.ref.messageId}:${view.ref.sourceKey}`}`
    : `draft:${view.draft.toolCallId}`;
