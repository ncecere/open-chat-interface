import type { CatalogModel, UserConnector } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plug, X } from 'lucide-react';
import { useState } from 'react';
import { fetchUserConnectors, USER_CONNECTORS_QUERY_KEY } from '~/lib/connectors';

/** Connector ids whose hint the person dismissed, in this browser. */
export const CONNECTOR_HINT_STORAGE_KEY = 'oci:dismissed-connector-hints';
const MAX_REMEMBERED = 100;

function readDismissed(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CONNECTOR_HINT_STORAGE_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]) {
  try {
    localStorage.setItem(CONNECTOR_HINT_STORAGE_KEY, JSON.stringify(ids.slice(-MAX_REMEMBERED)));
  } catch {
    // Storage full or blocked: the hint is dismissed until the page reloads.
  }
}

/**
 * The connector to suggest: the first (by name, as the API orders them) whose
 * tools the person's role may use but which they have not connected, or whose
 * connection expired, and whose hint they have not dismissed.
 */
export function connectorToSuggest(
  connectors: UserConnector[],
  dismissed: readonly string[],
): UserConnector | null {
  return (
    connectors.find(
      (connector) =>
        !connector.connected && connector.toolCount > 0 && !dismissed.includes(connector.id),
    ) ?? null
  );
}

/**
 * A small note above the composer: "Connect Docs to let the model use its
 * tools", when the selected model can call tools and an OAuth connector with
 * tools allowed for the person's role is not connected. One at a time;
 * dismissing it is remembered per connector in this browser.
 */
export function ComposerConnectHint({ selectedModel }: { selectedModel: CatalogModel | null }) {
  const supportsTools = selectedModel?.capabilities.includes('tool_calling') ?? false;
  const connectors = useQuery({
    queryKey: USER_CONNECTORS_QUERY_KEY,
    queryFn: fetchUserConnectors,
    enabled: supportsTools,
    staleTime: 5 * 60_000,
  });
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!supportsTools) return null;
  const connector = connectorToSuggest(connectors.data?.connectors ?? [], dismissed);
  if (!connector) return null;

  function dismiss(id: string) {
    const next = [...dismissed, id];
    setDismissed(next);
    writeDismissed(next);
  }

  return (
    <div
      role="note"
      aria-label={`Connect ${connector.name}`}
      className="mb-2 flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)] py-1.5 pl-3 pr-1.5 text-[0.8125rem] text-[var(--text-secondary)]"
      data-testid="composer-connect-hint"
    >
      <Plug className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <Link
          to="/settings/connectors"
          className="font-medium text-[var(--text-primary)] underline underline-offset-2 hover:text-[var(--accent-bright)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
        >
          {connector.needsReconnect ? 'Reconnect' : 'Connect'} {connector.name}
        </Link>{' '}
        to let the model use its tools.
      </p>
      <button
        type="button"
        onClick={() => dismiss(connector.id)}
        aria-label={`Dismiss: connect ${connector.name}`}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-bright)]"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
