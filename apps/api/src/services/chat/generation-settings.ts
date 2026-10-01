import type { ProviderKind, ReasoningEffort } from '@oci/shared';
import { validationFailed } from '../../lib/errors.js';
import { reasoningCallSettings } from '../reasoning.js';

/**
 * Mirrors the budgeted/adaptive distinction and legacy clamps in the pinned
 * @ai-sdk/anthropic adapter. Keep the wire-format regression matrix when upgrading.
 * null = adaptive; undefined = unknown budgeted model (no SDK output clamp).
 */
function budgetedAnthropicMaximum(id: string): number | null | undefined {
  if (
    [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
    ].some((family) => id.includes(family))
  )
    return null;
  if (
    ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-haiku-4-5'].some((family) =>
      id.includes(family),
    )
  )
    return 64000;
  // Preserve SDK precedence even for gateway aliases containing multiple families.
  if (id.includes('claude-opus-4-1')) return 32000;
  if (id.includes('claude-sonnet-4-')) return 64000;
  if (id.includes('claude-opus-4-')) return 32000;
  if (id.includes('claude-3-haiku')) return 4096;
  if (/claude-(?:instant(?:-|$)|v?2(?=$|[-.:])|3(?=$|[-.]))/.test(id)) return undefined;
  return id.includes('claude-') ? null : undefined;
}

/** The reserved total includes thinking, not just the visible answer. */
export function generationSettings(
  effort: ReasoningEffort | undefined,
  providerKind: ProviderKind,
  modelId: string,
  totalOutputTokens: number,
) {
  if (!Number.isSafeInteger(totalOutputTokens) || totalOutputTokens < 1)
    throw validationFailed('The model has an invalid output limit');
  const base = reasoningCallSettings(effort, providerKind);
  if (providerKind !== 'anthropic' || !effort || effort === 'instant')
    return { ...base, maxOutputTokens: totalOutputTokens };
  const maximum = budgetedAnthropicMaximum(modelId);
  if (maximum === null) return { ...base, maxOutputTokens: totalOutputTokens };
  const total = Math.min(totalOutputTokens, maximum ?? totalOutputTokens);
  // Legacy Anthropic thinking requires 1024 tokens and some answer capacity.
  if (total <= 1024)
    throw validationFailed(
      'Thinking requires an output budget of at least 1025 tokens. Choose Instant or ask an administrator to increase the output limit.',
    );
  const fraction = { low: 0.1, medium: 0.3, high: 0.6 }[effort];
  const thinking = Math.min(total - 1, Math.max(1024, Math.round(total * fraction)));
  return {
    ...base,
    // This adapter adds thinking.budgetTokens to maxOutputTokens on the wire.
    maxOutputTokens: total - thinking,
    providerOptions: {
      anthropic: { thinking: { type: 'enabled' as const, budgetTokens: thinking } },
    },
  };
}
