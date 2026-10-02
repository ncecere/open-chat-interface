import type { CatalogModel, ReasoningEffort } from '@oci/shared';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/use-current-user';
import { coerceReasoningEffort } from '~/lib/reasoning';

/**
 * The composer's reasoning level.
 *
 * Until the person picks one, it follows the administrator's default; either
 * way it is clamped to what the selected model offers this person's role, and
 * falls back to instant. A level picked for one model is kept, so switching to
 * a model without it and back again restores it.
 */
export function useComposerEffort(
  model: CatalogModel | null,
  initialEffort?: ReasoningEffort,
): [ReasoningEffort, (effort: ReasoningEffort) => void] {
  const { data } = useCurrentUser();
  const defaultEffort = data?.chat?.defaultEffort ?? 'instant';
  const [chosen, setChosen] = useState<ReasoningEffort | null>(initialEffort ?? null);
  return [coerceReasoningEffort(model, chosen ?? defaultEffort), setChosen];
}
