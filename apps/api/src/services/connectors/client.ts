import { createMCPClient, type MCPClient, type OAuthClientProvider } from '@ai-sdk/mcp';
import { AppError, providerError } from '../../lib/errors.js';
import { APP_VERSION } from '../../version.js';
import { CONNECTOR_LIMITS } from './limits.js';
import { assertAllowedUrl, createGuardedFetch, findNetworkError } from './network.js';
import { recordContact, recordFailure } from './store.js';

/** Where and how to reach one connector's server. */
interface ConnectionTarget {
  id: string;
  name: string;
  url: string;
  allowPrivateNetwork: boolean;
}

/** A shared credential header, or a person's OAuth tokens; neither for `none`. */
export interface ConnectionAuth {
  headers?: Record<string, string>;
  authProvider?: OAuthClientProvider;
  /** Message for a refused OAuth connection, naming where to reconnect. */
  reconnectMessage?: string;
}

/** The network policy for a connector: its own private-network choice and the size limit. */
export function connectorFetch(target: Pick<ConnectionTarget, 'allowPrivateNetwork'>) {
  return createGuardedFetch({
    allowPrivateNetwork: target.allowPrivateNetwork,
    maxResponseBytes: CONNECTOR_LIMITS.maxResponseBytes,
    idleTimeoutMs: CONNECTOR_LIMITS.timeoutMs,
  });
}

const statusOf = (error: unknown): number | null => {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    const status = (current as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
};

const isUnauthorized = (error: unknown) => {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if ((current as { name?: unknown }).name === 'UnauthorizedError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/** A JSON-RPC error the server sent for this request (`code` set by the MCP client). */
const rpcMessage = (error: unknown): string | null => {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (
    candidate &&
    typeof candidate.code === 'number' &&
    typeof candidate.message === 'string' &&
    candidate.message.trim()
  )
    return candidate.message.trim().replace(/\s+/g, ' ').slice(0, 200);
  return null;
};

/**
 * The person-facing failure for a connector exchange. Our own wording only,
 * apart from a JSON-RPC error's short message: no URLs, response bodies or
 * credentials. Exported for tests.
 */
export function connectorFailure(
  name: string,
  error: unknown,
  signal: AbortSignal | undefined,
  auth: Pick<ConnectionAuth, 'reconnectMessage'> = {},
): AppError {
  if (error instanceof AppError) return error;
  const network = findNetworkError(error);
  const clientTimeout =
    error instanceof Error && error.name === 'MCPClientError' && /timed out/i.test(error.message);
  if (
    network?.reason === 'timeout' ||
    clientTimeout ||
    (signal?.aborted && signal.reason?.name === 'TimeoutError')
  )
    return providerError(`${name} did not respond in time.`);
  if (network) return providerError(`${name} could not be used. ${network.message}`);
  if (isUnauthorized(error) && auth.reconnectMessage) return providerError(auth.reconnectMessage);
  const status = statusOf(error);
  if (status === 401 || status === 403)
    return providerError(
      auth.reconnectMessage ??
        `${name} refused OCI’s credentials. Ask an administrator to check them.`,
    );
  if (status !== null) return providerError(`${name} returned an error (HTTP ${status}).`);
  const rpc = rpcMessage(error);
  if (rpc) return providerError(`${name} returned an error: ${rpc}`);
  if (signal?.aborted) return providerError(`${name} did not respond in time.`);
  return providerError(`${name} could not be reached.`);
}

/**
 * Opens an MCP client for one exchange, runs `use`, and always closes it.
 * Connections are not pooled: each call initializes its own session, which
 * keeps credentials and the network check per call. Contact and failures are
 * recorded on the connector.
 */
export async function withMcpClient<T>(
  target: ConnectionTarget,
  auth: ConnectionAuth,
  signal: AbortSignal,
  use: (client: MCPClient) => Promise<T>,
): Promise<T> {
  let client: MCPClient | undefined;
  try {
    assertAllowedUrl(target.url, target);
    client = await createMCPClient({
      transport: {
        type: 'http',
        url: target.url,
        headers: auth.headers,
        authProvider: auth.authProvider,
        fetch: connectorFetch(target),
        redirect: 'error',
      },
      clientName: 'open-chat-interface',
      version: APP_VERSION,
      initializationOptions: { signal, timeout: CONNECTOR_LIMITS.timeoutMs },
      // Errors on the optional server-to-client stream are not this call's failure.
      onUncaughtError: () => {},
    });
    const result = await use(client);
    await recordContact(target.id);
    return result;
  } catch (error) {
    const failure = connectorFailure(target.name, error, signal, auth);
    await recordFailure(target.id, failure.message);
    throw failure;
  } finally {
    if (client) await closeQuietly(client);
  }
}

/** Closes a client without waiting long on the server's session teardown. */
async function closeQuietly(client: MCPClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    client.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}
