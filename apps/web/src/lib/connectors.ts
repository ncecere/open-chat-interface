import type { UserConnector } from '@oci/shared';
import { api } from '~/lib/api-client';

/**
 * GET /connectors: OAuth connectors with a tool allowed for the person's role,
 * and whether each is connected. Shared by Settings → Connectors and the
 * composer's connect hint, so connecting or disconnecting updates both.
 */
export const USER_CONNECTORS_QUERY_KEY = ['connectors'] as const;

export function fetchUserConnectors() {
  return api.get<{ connectors: UserConnector[] }>('/connectors');
}

/** Messages for the outcome of connecting an account, carried back in the URL. */
export const CONNECT_OUTCOMES: Record<string, string> = {
  state: 'That sign-in link was not valid any more. Start connecting again.',
  denied: 'Signing in was cancelled.',
  failed: 'The service did not accept the sign-in. Try connecting again.',
  'signed-out': 'Sign in to OCI first, then connect again.',
};

/**
 * Starts connecting the signed-in person's account to an OAuth connector and
 * sends the browser to the service's sign-in page. The service redirects back
 * to Settings → Connectors (or the admin Connectors page).
 */
export async function startConnecting(connectorId: string, returnTo: 'settings' | 'admin') {
  const { authorizationUrl } = await api.post<{ authorizationUrl: string }>(
    `/connectors/${connectorId}/connect`,
    { returnTo },
  );
  window.location.assign(authorizationUrl);
}
