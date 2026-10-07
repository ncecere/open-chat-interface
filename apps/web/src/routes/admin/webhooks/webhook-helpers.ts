import type { WebhookEndpoint } from '@oci/shared';

export const WEBHOOKS_QUERY_KEY = ['admin', 'webhooks'] as const;

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

/** One action per line or comma; blanks dropped, duplicates removed. Exported for tests. */
export function parseActions(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/** The entries (actions, or prefixes such as `user.*`) that match no recorded action. */
export function unmatchedActions(actions: string[], known: string[]): string[] {
  return actions.filter((action) =>
    action.endsWith('.*')
      ? !known.some((name) => name.startsWith(action.slice(0, -1)))
      : !known.includes(action),
  );
}

export interface Draft {
  url: string;
  description: string;
  allActions: boolean;
  actions: string;
  enabled: boolean;
  allowPrivateNetwork: boolean;
}

/** Only the fields that differ from the saved endpoint. Exported for tests. */
export function webhookChanges(saved: WebhookEndpoint, draft: Draft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.url.trim() !== saved.url) patch.url = draft.url.trim();
  if (draft.description.trim() !== saved.description) patch.description = draft.description.trim();
  if (draft.allActions !== saved.allActions) patch.allActions = draft.allActions;
  const actions = parseActions(draft.actions);
  if (JSON.stringify([...actions].sort()) !== JSON.stringify([...saved.actions].sort()))
    patch.actions = actions;
  if (draft.enabled !== saved.enabled) patch.enabled = draft.enabled;
  if (draft.allowPrivateNetwork !== saved.allowPrivateNetwork)
    patch.allowPrivateNetwork = draft.allowPrivateNetwork;
  return patch;
}
