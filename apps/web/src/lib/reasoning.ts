import { type CatalogModel, effectiveSupportedEfforts, type ReasoningEffort } from '@oci/shared';

/** Keeps composer state valid when the selected model changes. */
export function coerceReasoningEffort(
  model: CatalogModel | null,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (!model) return 'instant';
  const supportedEfforts = effectiveSupportedEfforts(model);
  if (supportedEfforts.length === 0) return 'instant';
  if (supportedEfforts.includes(effort)) return effort;
  return supportedEfforts.includes('instant') ? 'instant' : (supportedEfforts[0] ?? 'instant');
}

/** Unsupported models must omit effort rather than sending stale UI state. */
export function reasoningEffortForRequest(
  model: CatalogModel | null,
  effort: ReasoningEffort,
): ReasoningEffort | undefined {
  return model && effectiveSupportedEfforts(model).includes(effort) ? effort : undefined;
}
