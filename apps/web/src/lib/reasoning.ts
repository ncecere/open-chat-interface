import {
  type CatalogModel,
  clampReasoningEffort,
  effectiveSupportedEfforts,
  type ReasoningEffort,
} from '@oci/shared';

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
