import { type CatalogModel, REASONING_EFFORTS, type ReasoningEffort } from '@oci/shared';
import type { UIMessage } from 'ai';

/**
 * Where the composer starts (v0.10): an explicit choice in this conversation,
 * then the person's own default (Settings → Models, stored with the account),
 * then the instance default. A choice that is no longer in the person's
 * catalog is skipped silently.
 *
 * Before v0.10 the last model picked was remembered per browser under
 * `oci.model`; that key is no longer read, so a new device and an old one
 * start from the same place. `forgetBrowserModel` removes the stale value.
 */
export function startingModel(
  models: readonly CatalogModel[],
  ...preferred: Array<string | null | undefined>
): CatalogModel | null {
  for (const slug of preferred) {
    if (!slug) continue;
    const match = models.find((model) => model.slug === slug);
    if (match) return match;
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

/** The pre-v0.10 per-browser model; read by nothing now. */
const LEGACY_MODEL_STORAGE_KEY = 'oci.model';

export function forgetBrowserModel(): void {
  try {
    localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY);
  } catch {
    // Blocked storage holds nothing to forget.
  }
}

interface RecordedChoice {
  modelSlug?: unknown;
  effort?: unknown;
}

/**
 * The model and level this conversation last used: the newest stored message
 * that recorded a model. Its level is absent when that message sent none.
 */
export function conversationChoice(messages: readonly UIMessage[]): {
  modelSlug: string | null;
  effort: ReasoningEffort | undefined;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = messages[index]?.metadata as RecordedChoice | undefined;
    if (typeof metadata?.modelSlug === 'string' && metadata.modelSlug) {
      return {
        modelSlug: metadata.modelSlug,
        effort: REASONING_EFFORTS.find((effort) => effort === metadata.effort),
      };
    }
  }
  return { modelSlug: null, effort: undefined };
}
