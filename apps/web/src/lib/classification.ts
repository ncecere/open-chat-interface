import {
  type ClassificationClass,
  type ClassificationModel,
  type ClassificationResponse,
  type DataClassBlockedDetails,
  type DataClassificationPartData,
  dataClassBlockedDetailsSchema,
  ERROR_CODES,
} from '@oci/shared';
import { ApiError } from '~/lib/api-client';

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

/**
 * Why a conversation or project carries a class, in the words the chips use:
 * "from the project", "from the SIS connector", "added by you". A class can
 * have several reasons.
 */
export function reasonTexts(entry: ClassificationClass, scope: 'thread' | 'project'): string[] {
  const texts: string[] = [];
  for (const reason of entry.reasons) {
    if (reason === 'project') {
      texts.push(
        scope === 'project'
          ? entry.locked
            ? 'set by an administrator'
            : 'added by you'
          : entry.locked
            ? 'from the project, set by an administrator'
            : 'from the project',
      );
    } else if (reason === 'connector') {
      const names = entry.connectorNames ?? [];
      texts.push(
        names.length === 0
          ? 'from a connector'
          : `from the ${listNames(names)} ${names.length === 1 ? 'connector' : 'connectors'}`,
      );
    } else if (reason === 'person') {
      texts.push('added by you');
    } else {
      texts.push(keptText(entry.origins ?? []));
    }
  }
  return texts;
}

/** A `kept` label stays after what gave it was moved away from or deleted. */
function keptText(origins: readonly string[]): string {
  const connectors = origins.flatMap((origin) =>
    origin.startsWith('connector: ') ? [origin.slice('connector: '.length)] : [],
  );
  const fromProject = origins.includes('project');
  const parts = [
    ...(fromProject ? ['its earlier project'] : []),
    ...connectors.map((name) => `the removed ${name} connector`),
  ];
  return parts.length ? `kept from ${listNames(parts)}` : 'kept from before';
}

/**
 * Why this label has no remove button, in one sentence for the person.
 * Only what the person added can be removed from the conversation.
 */
export function whyNotRemovable(entry: ClassificationClass, scope: 'thread' | 'project'): string {
  if (scope === 'project')
    return `${entry.name} was set by an administrator, so only an administrator can remove it.`;
  const reasons = entry.reasons.filter((reason) => reason !== 'person');
  if (reasons.includes('connector'))
    return `${entry.name} comes from a connector this conversation used, so it stays as long as the connector carries it.`;
  if (reasons.includes('project'))
    return `${entry.name} comes from the project. Change the project’s labels to remove it.`;
  return `${entry.name} was kept when the project or connector it came from went away. It cannot be removed.`;
}

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
  return `Not approved for ${listNames(model.missing.map((entry) => entry.name))}`;
}

/** What `block` would have refused, as the amber note beside a model in `warn`. */
export function warnNoteText(model: ClassificationModel): string {
  return `${notApprovedText(model)}. You can still use it; the administrator is told.`;
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
  const names = listNames(part.missing);
  switch (part.point) {
    case 'send':
    case 'approval':
      return `This conversation carries ${names}, which this model is not approved for. It was sent anyway because data classification is set to warn; the administrator can see this in the audit log.`;
    case 'tool':
      return `A tool was used in a conversation that carries ${names}, which it is not approved for. It ran because data classification is set to warn.`;
    case 'compaction':
      return `Earlier messages were summarised by a model that is not approved for ${names}. It went ahead because data classification is set to warn.`;
    case 'web_search':
      return `The web search was made from a conversation that carries ${names}, which web search is not approved for. It went ahead because data classification is set to warn.`;
    case 'embedding':
    case 'rerank':
      return `Project search sent text to a service that is not approved for ${names}. It went ahead because data classification is set to warn.`;
    case 'share':
      return `This conversation carries ${names}, and a share link is open to anyone who has it. It was allowed because data classification is set to warn.`;
  }
}
