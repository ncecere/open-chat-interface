import type { ProviderKind, UpdateProviderInput } from '@oci/shared';

export interface ProviderCredentialState {
  kind: ProviderKind;
  label: string;
  baseUrl: string | null;
  enabled: boolean;
  encryptedApiKey: string | null;
  credentialHint: string | null;
}

export interface ProviderConfigurationIssue {
  field: 'kind' | 'label' | 'baseUrl';
  message: string;
}

/**
 * Applies write-only secret semantics so an admin can edit connection details
 * without re-entering the key: omitted/blank keeps, a value replaces, and null
 * clears. The plaintext key never leaves this boundary.
 */
export function applyProviderPatch(
  current: ProviderCredentialState,
  patch: UpdateProviderInput,
  encrypt: (secret: string) => string,
  hint: (secret: string) => string,
): ProviderCredentialState {
  const { apiKey, ...connection } = patch;
  const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : apiKey;

  return {
    ...current,
    ...(connection.kind !== undefined && { kind: connection.kind }),
    ...(connection.label !== undefined && { label: connection.label }),
    ...(connection.baseUrl !== undefined && { baseUrl: connection.baseUrl }),
    ...(connection.enabled !== undefined && { enabled: connection.enabled }),
    ...(trimmedKey === null
      ? { encryptedApiKey: null, credentialHint: null }
      : trimmedKey
        ? { encryptedApiKey: encrypt(trimmedKey), credentialHint: hint(trimmedKey) }
        : {}),
  };
}

/** Validates the merged result so a partial edit cannot leave a provider unusable. */
export function getProviderConfigurationIssues(
  provider: ProviderCredentialState,
): ProviderConfigurationIssue[] {
  const issues: ProviderConfigurationIssue[] = [];

  if (!provider.label.trim()) {
    issues.push({ field: 'label', message: 'A display name is required.' });
  }

  if (provider.kind === 'openai-compatible' && !provider.baseUrl?.trim()) {
    issues.push({
      field: 'baseUrl',
      message: 'OpenAI-compatible providers require a base URL.',
    });
  }

  if (provider.baseUrl) {
    try {
      const url = new URL(provider.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        issues.push({ field: 'baseUrl', message: 'Base URL must use HTTP or HTTPS.' });
      }
      if (url.username || url.password) {
        issues.push({ field: 'baseUrl', message: 'Base URL must not include credentials.' });
      }
    } catch {
      issues.push({ field: 'baseUrl', message: 'Base URL must be a valid absolute URL.' });
    }
  }

  return issues;
}
