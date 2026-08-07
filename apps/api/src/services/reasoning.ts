import type { ProviderKind, ReasoningEffort } from '@oci/shared';
import { validationFailed } from '../lib/errors.js';

export type SdkReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export interface ReasoningCallSettings {
  reasoning: SdkReasoningEffort;
  providerOptions?: {
    openaiCompatible: {
      reasoningEffort: SdkReasoningEffort;
    };
  };
}

/**
 * Reject effort values that the curated catalog did not explicitly enable for
 * this model. UI controls are not a security or correctness boundary: clients
 * can call the chat endpoint directly or retain stale state after a model
 * switch.
 */
export function assertReasoningEffortSupported(
  effort: ReasoningEffort | undefined,
  supportedEfforts: ReasoningEffort[],
): void {
  if (effort && !supportedEfforts.includes(effort)) {
    throw validationFailed(`Reasoning effort "${effort}" is not supported by this model`);
  }
}

/**
 * Uses AI SDK's provider-neutral reasoning control so each adapter performs
 * the model-specific mapping (for example Gemini 3 thinking levels versus
 * Gemini 2.5 token budgets, and adaptive versus budgeted Anthropic thinking).
 *
 * The openai-compatible adapter intentionally omits top-level `none`, so its
 * generic provider namespace is also supplied to make OCI's `instant` setting
 * explicit rather than falling back to an upstream gateway default.
 */
export function reasoningCallSettings(
  effort: ReasoningEffort | undefined,
  providerKind: ProviderKind,
): ReasoningCallSettings | Record<string, never> {
  if (!effort) return {};

  const reasoning: SdkReasoningEffort = effort === 'instant' ? 'none' : effort;
  return {
    reasoning,
    ...(providerKind === 'openai-compatible'
      ? { providerOptions: { openaiCompatible: { reasoningEffort: reasoning } } }
      : {}),
  };
}
