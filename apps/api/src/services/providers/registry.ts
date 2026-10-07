import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ProviderKind } from '@oci/shared';
import type { LanguageModel } from 'ai';
import { providerError } from '../../lib/errors.js';

export interface ProviderCredentials {
  kind: ProviderKind;
  label: string;
  apiKey: string | null;
  baseUrl: string | null;
}

/**
 * Builds an AI SDK language model for an admin-configured provider. Model IDs
 * always come from the curated catalog, never from client input.
 */
export function createLanguageModel(
  credentials: ProviderCredentials,
  upstreamModelId: string,
): LanguageModel {
  switch (credentials.kind) {
    case 'openai': {
      const openai = createOpenAI({
        apiKey: credentials.apiKey ?? undefined,
        ...(credentials.baseUrl && { baseURL: credentials.baseUrl }),
      });
      return openai(upstreamModelId);
    }
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: credentials.apiKey ?? undefined,
        ...(credentials.baseUrl && { baseURL: credentials.baseUrl }),
      });
      return anthropic(upstreamModelId);
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: credentials.apiKey ?? undefined,
        ...(credentials.baseUrl && { baseURL: credentials.baseUrl }),
      });
      return google(upstreamModelId);
    }
    case 'openai-compatible': {
      if (!credentials.baseUrl) {
        throw providerError('OpenAI-compatible providers require a base URL');
      }
      const compatible = createOpenAICompatible({
        name: credentials.label,
        baseURL: credentials.baseUrl,
        apiKey: credentials.apiKey ?? undefined,
        // Streaming responses omit token counts unless the request opts in.
        // Without this, gateways such as LiteLLM report zero usage and budget
        // quotas can never bill a streamed generation.
        includeUsage: true,
      });
      return compatible(upstreamModelId);
    }
    default:
      throw providerError(`Unsupported provider kind: ${credentials.kind}`);
  }
}

const DISCOVERY_ENDPOINTS: Record<ProviderKind, string | null> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  'openai-compatible': null,
};

interface DiscoveryResult {
  id: string;
  displayName: string;
}

/**
 * Why a request never got an answer, in words: Node's fetch says only "fetch
 * failed", with the reason in its cause's code, which the page showed as it
 * was (#228). Exported for tests.
 */
export function unreachableReason(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError')
    return 'it did not answer within 15 seconds.';
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
      return 'its address could not be found. Check the base URL.';
    if (code === 'ECONNREFUSED') return 'it refused the connection. Check the base URL and port.';
    if (code === 'ECONNRESET') return 'the connection was closed before it answered.';
    if (typeof code === 'string' && /CERT|SSL|TLS/.test(code))
      return 'its TLS certificate could not be verified.';
    current = (current as { cause?: unknown }).cause;
  }
  return 'there was no answer from its address. Check the base URL and the network.';
}

/**
 * Lists the models a credential can reach upstream. Availability in OCI is a
 * separate decision: nothing is exposed until an admin adds it to the catalog.
 */
export async function discoverModels(credentials: ProviderCredentials): Promise<DiscoveryResult[]> {
  const endpoint =
    credentials.kind === 'openai-compatible'
      ? `${credentials.baseUrl?.replace(/\/$/, '')}/models`
      : DISCOVERY_ENDPOINTS[credentials.kind];

  if (!endpoint) throw providerError('Model discovery is not available for this provider');

  const headers: Record<string, string> = { accept: 'application/json' };

  if (credentials.kind === 'anthropic') {
    headers['x-api-key'] = credentials.apiKey ?? '';
    headers['anthropic-version'] = '2023-06-01';
  } else if (credentials.kind === 'google') {
    headers['x-goog-api-key'] = credentials.apiKey ?? '';
  } else if (credentials.apiKey) {
    headers.authorization = `Bearer ${credentials.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw providerError(`Could not reach the provider: ${unreachableReason(error)}`);
  }

  if (!response.ok) {
    throw providerError(`Provider responded with ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return normalizeDiscovery(credentials.kind, payload);
}

function normalizeDiscovery(
  kind: ProviderKind,
  payload: Record<string, unknown>,
): DiscoveryResult[] {
  if (kind === 'google') {
    const models = (payload.models ?? []) as { name?: string; displayName?: string }[];
    return models
      .filter((entry) => Boolean(entry.name))
      .map((entry) => {
        const id = entry.name!.replace(/^models\//, '');
        return { id, displayName: entry.displayName ?? id };
      });
  }

  const data = (payload.data ?? []) as { id?: string; display_name?: string }[];
  return data
    .filter((entry) => Boolean(entry.id))
    .map((entry) => ({ id: entry.id!, displayName: entry.display_name ?? entry.id! }));
}
