import { type ArtifactKind, artifactKindLabel } from '@oci/shared';
import { translate } from '~/lib/i18n';

/**
 * An artifact's kind as a person reads it, in the language shown. The shared
 * helper is English; formats and programming languages ("HTML", "Python") are
 * names and stay as they are, the words "Document", "Code" and "Artifact" are
 * translated.
 */
export function artifactKindName(kind: ArtifactKind, language?: string | null): string {
  const label = artifactKindLabel(kind, language);
  if (kind === 'markdown') return translate('artifacts.kind.document');
  if (kind === 'code' && label === 'Code') return translate('artifacts.kind.code');
  if (label === 'Artifact') return translate('artifacts.kind.artifact');
  return label;
}
