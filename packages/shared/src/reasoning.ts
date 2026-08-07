import { REASONING_EFFORTS, type ReasoningEffort } from './constants.js';

interface EffortSupport {
  capabilities: readonly string[];
  supportedEfforts: readonly ReasoningEffort[];
}

/**
 * Older catalog entries used `effort_control` as the only support flag. Keep
 * those models functional while allowing newer entries to advertise a more
 * precise subset of levels through `supportedEfforts`.
 */
export function effectiveSupportedEfforts(model: EffortSupport): ReasoningEffort[] {
  if (model.supportedEfforts.length > 0) return [...model.supportedEfforts];
  return model.capabilities.includes('effort_control') ? [...REASONING_EFFORTS] : [];
}
