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
  field: 'kind' | 'label' | 'baseUrl' | 'apiKey';
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

  // OpenAI, Anthropic and Google always need a key; an empty Add provider
  // form used to create an enabled OpenAI provider that could never answer.
  // OpenAI-compatible endpoints may genuinely need none, and a disabled
  // provider can wait for its key.
  if (provider.enabled && provider.kind !== 'openai-compatible' && !provider.encryptedApiKey) {
    issues.push({ field: 'apiKey', message: 'An API key is required for this provider.' });
  }

  if (provider.baseUrl) {
    try {
      const url = new URL(provider.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        // Shown after the field's name ("Base URL: …"), so not naming it again (#228).
        issues.push({ field: 'baseUrl', message: 'Use an http:// or https:// address.' });
      }
      if (url.username || url.password) {
        issues.push({
          field: 'baseUrl',
          message: 'Leave the username and password out; give the key as the API key.',
        });
      }
    } catch {
      issues.push({
        field: 'baseUrl',
        message: 'Enter a full address, such as https://gateway.example.com/v1.',
      });
    }
  }

  return issues;
}
