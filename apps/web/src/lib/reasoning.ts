import {
  type CatalogModel,
  clampReasoningEffort,
  effectiveSupportedEfforts,
  type ReasoningEffort,
} from '@oci/shared';
import { type MessageKey, translate } from '~/lib/i18n';

/**
 * Keeps composer state valid when the selected model changes. The catalog
 * already lists only the levels the person's role may use, so this also keeps
 * a withheld level from being shown or sent.
 */
export function coerceReasoningEffort(
  model: CatalogModel | null,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (!model) return 'instant';
  return clampReasoningEffort(effort, effectiveSupportedEfforts(model));
}

/** Unsupported models must omit effort rather than sending stale UI state. */
export function reasoningEffortForRequest(
  model: CatalogModel | null,
  effort: ReasoningEffort,
): ReasoningEffort | undefined {
  return model && effectiveSupportedEfforts(model).includes(effort) ? effort : undefined;
}

const EFFORT_KEYS = {
  instant: 'chat.effort.instant',
  low: 'chat.effort.low',
  medium: 'chat.effort.medium',
  high: 'chat.effort.high',
} as const satisfies Record<ReasoningEffort, MessageKey>;

/** The name of a reasoning level as a person reads it (the value itself is an API word). */
export function effortLabel(effort: string): string {
  return effort in EFFORT_KEYS ? translate(EFFORT_KEYS[effort as ReasoningEffort]) : effort;
}
