import type { SsoProviderSummary } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_POLICY,
  EMPTY_PROTOCOL,
  type PolicyDraft,
  type ProtocolDraft,
  policyFromProvider,
  splitList,
  toCreateBody,
  toPatchBody,
} from '../../src/routes/admin/sso-form/provider-draft';

const policy: PolicyDraft = { ...EMPTY_POLICY, label: ' Company SSO ' };
const oidc: ProtocolDraft = {
  ...EMPTY_PROTOCOL,
  providerId: ' company-sso ',
  issuer: ' https://id.example.com ',
  clientId: ' client-id ',
  clientSecret: ' client-secret ',
};
const saml: ProtocolDraft = {
  ...EMPTY_PROTOCOL,
  providerId: 'company-saml',
  kind: 'saml',
  issuer: ' urn:company:idp ',
  entryPoint: ' https://id.example.com/saml/sso ',
  idpCertificate: ' signing-certificate ',
};

const provider: SsoProviderSummary = {
  id: 'provider-record',
  providerId: 'company-sso',
  label: 'Company SSO',
  kind: 'oidc',
  enabled: false,
  jitProvisioning: false,
  trustedForLinking: true,
  allowedDomains: ['example.com', 'subsidiary.example'],
  defaultRole: 'admin',
  claimRoleMappings: [
    { claim: 'groups', value: 'engineering', role: 'admin' },
    { claim: 'groups', value: 'support', role: 'user' },
  ],
  requireRoleMatch: true,
  roleRequiredMessage: null,
  claimMappings: { email: 'mail', subject: 'subject-id' },
  autoRedirect: true,
  issuer: 'https://id.example.com',
  metadataUrl: null,
  callbackUrl: 'https://chat.example.com/callback',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('SSO provider draft initialization', () => {
  it('keeps the creation defaults', () => {
    expect(policyFromProvider()).toEqual(EMPTY_POLICY);
    expect(EMPTY_PROTOCOL).toEqual({
      providerId: '',
      kind: 'oidc',
      issuer: '',
      clientId: '',
      clientSecret: '',
      discoveryUrl: '',
      scopes: 'openid profile email',
      pkce: true,
      entryPoint: '',
      idpCertificate: '',
      audience: '',
      wantAssertionsSigned: true,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
    });
  });

  it('initializes policy fields and fresh role mapping IDs without changing the provider', () => {
    const draft = policyFromProvider(provider);
    expect(draft).toEqual({
      label: provider.label,
      enabled: false,
      jitProvisioning: false,
      trustedForLinking: true,
      allowedDomains: 'example.com, subsidiary.example',
      defaultRole: 'admin',
      claimRoleMappings: provider.claimRoleMappings.map((mapping) => ({
        ...mapping,
        draftId: expect.any(String),
      })),
      requireRoleMatch: true,
      roleRequiredMessage: '',
      autoRedirect: true,
      claimEmail: 'mail',
      claimName: '',
      claimImage: '',
      claimSubject: 'subject-id',
    });
    expect(new Set(draft.claimRoleMappings.map((mapping) => mapping.draftId)).size).toBe(2);
    expect(policyFromProvider(provider).claimRoleMappings[0]?.draftId).not.toBe(
      draft.claimRoleMappings[0]?.draftId,
    );
    expect(provider.claimRoleMappings[0]).not.toHaveProperty('draftId');
    expect(draft).not.toHaveProperty('issuer');
  });

  it('restores nonempty message and profile claims', () => {
    const draft = policyFromProvider({
      ...provider,
      roleRequiredMessage: 'Request access.',
      claimMappings: { name: 'displayName', image: 'avatar' },
    });
    expect(draft).toMatchObject({
      roleRequiredMessage: 'Request access.',
      claimEmail: '',
      claimName: 'displayName',
      claimImage: 'avatar',
      claimSubject: '',
    });
  });
});

describe('SSO provider request mapping', () => {
  it('splits lists on commas and whitespace, deduplicating in first-seen order', () => {
    expect(splitList(' email,openid\nemail\tprofile,, openid ')).toEqual([
      'email',
      'openid',
      'profile',
    ]);
    expect(splitList(' ,\n\t ')).toEqual([]);
  });

  it('deduplicates domains before lowercasing, preserving existing case-sensitive splitting', () => {
    const result = toPatchBody({
      ...policy,
      allowedDomains: 'EXAMPLE.COM, EXAMPLE.COM subsidiary.example example.com',
    });
    expect(result).toMatchObject({
      success: true,
      data: { allowedDomains: ['example.com', 'subsidiary.example', 'example.com'] },
    });
  });

  it('sends null for a blank role message and omits blank claim mapping keys', () => {
    expect(
      toPatchBody({
        ...policy,
        roleRequiredMessage: ' \n ',
        claimEmail: ' mail ',
        claimName: ' ',
        claimImage: '\t',
        claimSubject: ' subject-id ',
      }),
    ).toMatchObject({
      success: true,
      data: {
        label: 'Company SSO',
        roleRequiredMessage: null,
        claimMappings: { email: 'mail', subject: 'subject-id' },
      },
    });
    const result = toPatchBody(policy);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.data.claimMappings).toEqual({});
    expect(result.data).not.toHaveProperty('claimEmail');
    const mapped = toPatchBody({ ...policy, claimEmail: 'mail', claimName: ' ' });
    if (!mapped.success) throw new Error(mapped.error);
    expect(mapped.data.claimMappings).toEqual({ email: 'mail' });
  });

  it('trims a nonblank message and keeps all nonblank profile claims', () => {
    expect(
      toPatchBody({
        ...policy,
        roleRequiredMessage: ' Request access. ',
        claimEmail: ' mail ',
        claimName: ' displayName ',
        claimImage: ' avatar ',
        claimSubject: ' subject-id ',
      }),
    ).toMatchObject({
      success: true,
      data: {
        roleRequiredMessage: 'Request access.',
        claimMappings: {
          email: 'mail',
          name: 'displayName',
          image: 'avatar',
          subject: 'subject-id',
        },
      },
    });
  });

  it('patches only policy, stripping unexpected protocol settings, credentials and draft IDs', () => {
    const input = {
      ...oidc,
      ...policy,
      idpCertificate: 'certificate',
      claimRoleMappings: [
        { draftId: 'local-id', claim: ' groups ', value: ' engineering ', role: 'admin' as const },
      ],
    };
    const result = toPatchBody(input);
    expect(result).toEqual({
      success: true,
      data: {
        label: 'Company SSO',
        enabled: true,
        jitProvisioning: true,
        trustedForLinking: false,
        allowedDomains: [],
        defaultRole: 'user',
        requireRoleMatch: false,
        roleRequiredMessage: null,
        autoRedirect: false,
        claimMappings: {},
        claimRoleMappings: [{ claim: 'groups', value: 'engineering', role: 'admin' }],
      },
    });
    expect(input.claimRoleMappings[0]?.draftId).toBe('local-id');
  });

  it('creates OIDC with only OIDC protocol fields and deduplicated scopes', () => {
    const result = toCreateBody(policy, {
      ...oidc,
      scopes: 'openid,email openid\nprofile email',
      discoveryUrl: ' ',
      pkce: false,
      idpCertificate: 'irrelevant-certificate',
      entryPoint: 'not-a-url',
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    const patch = toPatchBody(policy);
    if (!patch.success) throw new Error(patch.error);
    expect(result.data).toEqual({
      ...patch.data,
      providerId: 'company-sso',
      kind: 'oidc',
      issuer: 'https://id.example.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      discoveryUrl: null,
      scopes: ['openid', 'email', 'profile'],
      pkce: false,
    });
  });

  it('creates SAML with only SAML protocol fields, null audience and no OIDC credentials', () => {
    const result = toCreateBody(policy, {
      ...saml,
      audience: ' ',
      wantAssertionsSigned: false,
      signatureAlgorithm: 'sha512',
      digestAlgorithm: 'sha512',
      clientId: 'irrelevant-client',
      clientSecret: 'irrelevant-secret',
      discoveryUrl: 'not-a-url',
    });
    if (!result.success) throw new Error(result.error);
    const patch = toPatchBody(policy);
    if (!patch.success) throw new Error(patch.error);
    expect(result.data).toEqual({
      ...patch.data,
      providerId: 'company-saml',
      kind: 'saml',
      issuer: 'urn:company:idp',
      entryPoint: 'https://id.example.com/saml/sso',
      idpCertificate: 'signing-certificate',
      audience: null,
      wantAssertionsSigned: false,
      signatureAlgorithm: 'sha512',
      digestAlgorithm: 'sha512',
    });
  });

  it('trims nonblank optional protocol fields', () => {
    expect(
      toCreateBody(policy, { ...oidc, discoveryUrl: ' https://id.example.com/discovery ' }),
    ).toMatchObject({
      success: true,
      data: { discoveryUrl: 'https://id.example.com/discovery' },
    });
    expect(toCreateBody(policy, { ...saml, audience: ' urn:chat:sp ' })).toMatchObject({
      success: true,
      data: { audience: 'urn:chat:sp' },
    });
  });

  it.each([oidc, saml])('strips role mapping draft IDs when creating $kind', (protocol) => {
    const result = toCreateBody(policyFromProvider(provider), protocol);
    if (!result.success) throw new Error(result.error);
    expect(result.data.claimRoleMappings).toEqual(provider.claimRoleMappings);
  });
});

describe('SSO provider validation errors', () => {
  it('validates policy before protocol, with label before role mappings', () => {
    expect(
      toCreateBody(
        {
          ...EMPTY_POLICY,
          claimRoleMappings: [{ draftId: 'local', claim: '', value: '', role: 'user' }],
        },
        EMPTY_PROTOCOL,
      ),
    ).toEqual({ success: false, error: 'Enter a display name.' });
    expect(toPatchBody(EMPTY_POLICY)).toEqual({ success: false, error: 'Enter a display name.' });
  });

  it.each([
    { claim: '', value: '', message: 'Each role mapping needs a claim.' },
    { claim: 'groups', value: ' ', message: 'Each role mapping needs a value.' },
  ])('preserves the mapping error: $message', ({ claim, value, message }) => {
    const draft: PolicyDraft = {
      ...policy,
      claimRoleMappings: [{ draftId: 'local', claim, value, role: 'user' }],
    };
    expect(toPatchBody(draft)).toEqual({ success: false, error: message });
    expect(toCreateBody(draft, EMPTY_PROTOCOL)).toEqual({ success: false, error: message });
  });

  it.each([oidc, saml])('validates provider ID before protocol fields for $kind', (protocol) => {
    expect(
      toCreateBody(policy, { ...protocol, providerId: 'INVALID', issuer: '', clientSecret: '' }),
    ).toEqual({
      success: false,
      error: 'Provider ID must be lowercase alphanumeric with dashes',
    });
  });

  it('keeps OIDC URL validation before client credentials', () => {
    expect(toCreateBody(policy, { ...oidc, issuer: 'not-a-url', clientId: '' })).toEqual({
      success: false,
      error: 'Invalid URL',
    });
  });

  it('keeps SAML entry point validation before certificate validation', () => {
    expect(toCreateBody(policy, { ...saml, entryPoint: 'not-a-url', idpCertificate: '' })).toEqual({
      success: false,
      error: 'Invalid URL',
    });
  });

  it.each([
    { protocol: oidc, patch: { clientSecret: '' } },
    { protocol: saml, patch: { idpCertificate: '' } },
  ])('requires the $protocol.kind credential', ({ protocol, patch }) => {
    expect(toCreateBody(policy, { ...protocol, ...patch })).toEqual({
      success: false,
      error: 'Too small: expected string to have >=1 characters',
    });
  });
});
