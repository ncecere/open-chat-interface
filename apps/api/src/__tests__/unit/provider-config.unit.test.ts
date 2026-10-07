import { describe, expect, it } from 'vitest';
import {
  applyProviderPatch,
  getProviderConfigurationIssues,
  type ProviderCredentialState,
} from '../../services/providers/config.js';

const encrypt = (secret: string) => `encrypted:${secret}`;
const hint = (secret: string) => secret.slice(-4);

function provider(overrides: Partial<ProviderCredentialState> = {}): ProviderCredentialState {
  return {
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: null,
    enabled: true,
    encryptedApiKey: 'encrypted:sk-original',
    credentialHint: 'inal',
    ...overrides,
  };
}

describe('provider credential patching', () => {
  it('keeps the stored key when the field is omitted', () => {
    const next = applyProviderPatch(provider(), { label: 'Renamed' }, encrypt, hint);

    expect(next.label).toBe('Renamed');
    expect(next.encryptedApiKey).toBe('encrypted:sk-original');
    expect(next.credentialHint).toBe('inal');
  });

  it('keeps the stored key when a blank string is submitted', () => {
    const next = applyProviderPatch(provider(), { apiKey: '   ' }, encrypt, hint);

    expect(next.encryptedApiKey).toBe('encrypted:sk-original');
  });

  it('replaces the key and hint when a value is submitted', () => {
    const next = applyProviderPatch(provider(), { apiKey: ' sk-replacement ' }, encrypt, hint);

    expect(next.encryptedApiKey).toBe('encrypted:sk-replacement');
    expect(next.credentialHint).toBe('ment');
  });

  it('clears the key and hint together when null is submitted', () => {
    const next = applyProviderPatch(provider(), { apiKey: null }, encrypt, hint);

    expect(next.encryptedApiKey).toBeNull();
    expect(next.credentialHint).toBeNull();
  });

  it('applies connection fields without touching the credential', () => {
    const next = applyProviderPatch(
      provider(),
      { kind: 'openai-compatible', baseUrl: 'https://gw.example/v1', enabled: false },
      encrypt,
      hint,
    );

    expect(next).toMatchObject({
      kind: 'openai-compatible',
      baseUrl: 'https://gw.example/v1',
      enabled: false,
      encryptedApiKey: 'encrypted:sk-original',
    });
  });

  it('allows explicitly clearing a base URL', () => {
    const next = applyProviderPatch(
      provider({ baseUrl: 'https://gw.example/v1' }),
      { baseUrl: null },
      encrypt,
      hint,
    );

    expect(next.baseUrl).toBeNull();
  });
});

describe('provider configuration validation', () => {
  it('accepts a valid provider', () => {
    expect(getProviderConfigurationIssues(provider())).toEqual([]);
  });

  it('requires a base URL for openai-compatible providers', () => {
    const issues = getProviderConfigurationIssues(provider({ kind: 'openai-compatible' }));

    expect(issues).toContainEqual({
      field: 'baseUrl',
      message: 'OpenAI-compatible providers require a base URL.',
    });
  });

  it.each(['openai', 'anthropic', 'google'] as const)(
    'requires an API key for an enabled %s provider',
    (kind) => {
      const issues = getProviderConfigurationIssues(
        provider({ kind, encryptedApiKey: null, credentialHint: null }),
      );
      expect(issues).toContainEqual({
        field: 'apiKey',
        message: 'An API key is required for this provider.',
      });
    },
  );

  it('lets a provider without a key exist while disabled, or when it is OpenAI-compatible', () => {
    const keyless = { encryptedApiKey: null, credentialHint: null };
    expect(getProviderConfigurationIssues(provider({ ...keyless, enabled: false }))).toEqual([]);
    expect(
      getProviderConfigurationIssues(
        provider({ ...keyless, kind: 'openai-compatible', baseUrl: 'http://llm.internal:8000/v1' }),
      ),
    ).toEqual([]);
  });

  it('requires a non-empty label', () => {
    const issues = getProviderConfigurationIssues(provider({ label: '   ' }));

    expect(issues.map((issue) => issue.field)).toContain('label');
  });

  it.each([
    ['ftp://gw.example/v1', 'Use an http:// or https:// address.'],
    [
      'https://user:pass@gw.example/v1',
      'Leave the username and password out; give the key as the API key.',
    ],
    ['not-a-url', 'Enter a full address, such as https://gateway.example.com/v1.'],
  ])('rejects unusable base URL %s', (baseUrl, message) => {
    const issues = getProviderConfigurationIssues(provider({ baseUrl }));

    expect(issues).toContainEqual({ field: 'baseUrl', message });
  });
});
