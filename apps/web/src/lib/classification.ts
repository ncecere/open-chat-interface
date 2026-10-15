import {
  type ClassificationModel,
  type ClassificationResponse,
  type DataClassBlockedDetails,
  type DataClassificationPartData,
  dataClassBlockedDetailsSchema,
  ERROR_CODES,
} from '@oci/shared';
import { ApiError } from '~/lib/api-client';
import { formatList, translate } from '~/lib/i18n';

/** The error code of a refusal by data classification (403). */
export const DATA_CLASS_BLOCKED = ERROR_CODES.DATA_CLASS_BLOCKED;

/** "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "2 connectors", "1 project": a count with its noun, or null when there are none. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string | null {
  return count > 0 ? `${count} ${count === 1 ? singular : plural}` : null;
}

// Why a class is carried, and why a label cannot be removed: the project chips'
// wording lives with its translations (v0.14, #397).
export { reasonTexts, whyNotRemovable } from './classification-reasons';

/** Whether classification is on for this answer (`warn` or `block`); off, absent and unreadable answers are not. */
export function isClassifying(
  classification: ClassificationResponse | undefined | null,
): classification is ClassificationResponse {
  return classification?.mode === 'warn' || classification?.mode === 'block';
}

/** The models a conversation's classes allow, by slug. */
export type ModelAvailability = ReadonlyMap<string, ClassificationModel>;

const NO_AVAILABILITY: ModelAvailability = new Map();

export function availabilityOf(
  classification: ClassificationResponse | undefined | null,
): ModelAvailability {
  if (!isClassifying(classification)) return NO_AVAILABILITY;
  return new Map(classification.models.map((model) => [model.slug, model]));
}

/** Slugs of the models the conversation's classes forbid (mode `block` only). */
export function blockedSlugs(
  classification: ClassificationResponse | undefined | null,
): ReadonlySet<string> {
  if (classification?.mode !== 'block') return new Set();
  return new Set(
    classification.models.filter((model) => model.status === 'blocked').map((model) => model.slug),
  );
}

/** "Not approved for Student records": the picker's text, and the composer's lead. */
export function notApprovedText(model: ClassificationModel): string {
  return translate('chat.classification.notApproved', {
    classes: formatList(model.missing.map((entry) => entry.name)),
  });
}

/** What `block` would have refused, as the amber note beside a model in `warn`. */
export function warnNoteText(model: ClassificationModel): string {
  return translate('chat.classification.warnNote', {
    classes: formatList(model.missing.map((entry) => entry.name)),
  });
}

/**
 * The details a refused send carries, from the failed request's error. The AI
 * SDK puts the response body in the error message, so it arrives as JSON.
 */
export function blockedDetailsOf(error: unknown): DataClassBlockedDetails | null {
  let body: unknown;
  if (error instanceof ApiError) {
    if (error.code !== DATA_CLASS_BLOCKED) return null;
    body = error.details;
  } else if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as {
        error?: { code?: unknown; details?: unknown };
      };
      if (parsed.error?.code !== DATA_CLASS_BLOCKED) return null;
      body = parsed.error.details;
    } catch {
      return null;
    }
  } else return null;
  const details = dataClassBlockedDetailsSchema.safeParse(body);
  return details.success ? details.data : null;
}

/** What a `data-classification` reply part says, by where the warning arose. */
export function warnedText(part: DataClassificationPartData): string {
  const classes = formatList(part.missing);
  switch (part.point) {
    case 'send':
    case 'approval':
      return translate('chat.classification.warnedSend', { classes });
    case 'tool':
      return translate('chat.classification.warnedTool', { classes });
    case 'compaction':
      return translate('chat.classification.warnedCompaction', { classes });
    case 'web_search':
      return translate('chat.classification.warnedWebSearch', { classes });
    case 'embedding':
    case 'rerank':
      return translate('chat.classification.warnedProjectSearch', { classes });
    case 'share':
      return translate('chat.classification.warnedShare', { classes });
  }
}
