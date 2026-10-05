import {
  type ClaimMappings,
  type ClaimRoleMapping,
  type CreateSsoProviderInput,
  createSsoProviderSchema,
  type SsoProviderSummary,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { z } from 'zod';

export const policySchema = z.object({
  label: z.string().trim().min(1, 'Enter a display name.').max(80),
  enabled: z.boolean(),
  jitProvisioning: z.boolean(),
  trustedForLinking: z.boolean(),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)),
  defaultRole: z.enum(USER_ROLES),
  requireRoleMatch: z.boolean(),
  roleRequiredMessage: z.string().trim().max(500),
  autoRedirect: z.boolean(),
  claimEmail: z.string().trim().max(120),
  claimName: z.string().trim().max(120),
  claimImage: z.string().trim().max(120),
  claimSubject: z.string().trim().max(120),
  claimRoleMappings: z.array(
    z.object({
      claim: z.string().trim().min(1, 'Each role mapping needs a claim.').max(120),
      value: z.string().trim().min(1, 'Each role mapping needs a value.').max(200),
      role: z.enum(USER_ROLES),
    }),
  ),
});

export type ProviderKind = SsoProviderSummary['kind'];

export interface DraftClaimRoleMapping extends ClaimRoleMapping {
  draftId: string;
}

export interface PolicyDraft {
  label: string;
  enabled: boolean;
  jitProvisioning: boolean;
  trustedForLinking: boolean;
  allowedDomains: string;
  defaultRole: UserRole;
  claimRoleMappings: DraftClaimRoleMapping[];
  requireRoleMatch: boolean;
  roleRequiredMessage: string;
  autoRedirect: boolean;
  claimEmail: string;
  claimName: string;
  claimImage: string;
  claimSubject: string;
}

export interface ProtocolDraft {
  providerId: string;
  kind: ProviderKind;
  issuer: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  scopes: string;
  pkce: boolean;
  entryPoint: string;
  idpCertificate: string;
  audience: string;
  wantAssertionsSigned: boolean;
  signatureAlgorithm: 'sha256' | 'sha512';
  digestAlgorithm: 'sha256' | 'sha512';
}

export const EMPTY_POLICY: PolicyDraft = {
  label: '',
  // Off until the admin has checked it, as the empty state advises.
  enabled: false,
  jitProvisioning: true,
  trustedForLinking: false,
  allowedDomains: '',
  defaultRole: 'user',
  claimRoleMappings: [],
  requireRoleMatch: false,
  roleRequiredMessage: '',
  autoRedirect: false,
  claimEmail: '',
  claimName: '',
  claimImage: '',
  claimSubject: '',
};

export const EMPTY_PROTOCOL: ProtocolDraft = {
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
};

export function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function policyFromProvider(provider?: SsoProviderSummary): PolicyDraft {
  return provider
    ? {
        label: provider.label,
        enabled: provider.enabled,
        jitProvisioning: provider.jitProvisioning,
        trustedForLinking: provider.trustedForLinking,
        allowedDomains: provider.allowedDomains.join(', '),
        defaultRole: provider.defaultRole,
        claimRoleMappings: provider.claimRoleMappings.map((mapping) => ({
          ...mapping,
          draftId: crypto.randomUUID(),
        })),
        requireRoleMatch: provider.requireRoleMatch,
        roleRequiredMessage: provider.roleRequiredMessage ?? '',
        autoRedirect: provider.autoRedirect,
        claimEmail: provider.claimMappings.email ?? '',
        claimName: provider.claimMappings.name ?? '',
        claimImage: provider.claimMappings.image ?? '',
        claimSubject: provider.claimMappings.subject ?? '',
      }
    : EMPTY_POLICY;
}

export type PatchSsoProviderBody = Omit<
  z.infer<typeof policySchema>,
  'claimEmail' | 'claimName' | 'claimImage' | 'claimSubject' | 'roleRequiredMessage'
> & {
  roleRequiredMessage: string | null;
  claimMappings: ClaimMappings;
};

export type ProviderDraftResult<Body> =
  | { success: true; data: Body }
  | { success: false; error: string };

export function toPatchBody(policy: PolicyDraft): ProviderDraftResult<PatchSsoProviderBody> {
  const result = policySchema.safeParse({
    ...policy,
    allowedDomains: splitList(policy.allowedDomains).map((domain) => domain.toLowerCase()),
    claimRoleMappings: policy.claimRoleMappings,
  });
  if (!result.success) {
    return { success: false, error: result.error.issues[0]?.message ?? 'Check the access policy.' };
  }

  const { claimEmail, claimName, claimImage, claimSubject, roleRequiredMessage, ...policyRest } =
    result.data;

  // The form holds one field per claim so each can be labelled; the API takes
  // them as one object, and a blank means "use the standard claim".
  return {
    success: true,
    data: {
      ...policyRest,
      roleRequiredMessage: roleRequiredMessage || null,
      claimMappings: {
        ...(claimEmail && { email: claimEmail }),
        ...(claimName && { name: claimName }),
        ...(claimImage && { image: claimImage }),
        ...(claimSubject && { subject: claimSubject }),
      },
    },
  };
}

export function toCreateBody(
  policy: PolicyDraft,
  protocol: ProtocolDraft,
): ProviderDraftResult<CreateSsoProviderInput> {
  // Policy validation must run before protocol validation, even for a new provider.
  const submitted = toPatchBody(policy);
  if (!submitted.success) return submitted;

  const protocolFields =
    protocol.kind === 'oidc'
      ? {
          kind: 'oidc' as const,
          issuer: protocol.issuer,
          clientId: protocol.clientId,
          clientSecret: protocol.clientSecret,
          discoveryUrl: protocol.discoveryUrl.trim() || null,
          scopes: splitList(protocol.scopes),
          pkce: protocol.pkce,
        }
      : {
          kind: 'saml' as const,
          issuer: protocol.issuer,
          entryPoint: protocol.entryPoint,
          idpCertificate: protocol.idpCertificate,
          audience: protocol.audience.trim() || null,
          wantAssertionsSigned: protocol.wantAssertionsSigned,
          signatureAlgorithm: protocol.signatureAlgorithm,
          digestAlgorithm: protocol.digestAlgorithm,
        };

  const result = createSsoProviderSchema.safeParse({
    ...submitted.data,
    providerId: protocol.providerId,
    ...protocolFields,
  });
  if (!result.success) {
    return {
      success: false,
      error: result.error.issues[0]?.message ?? 'Check the provider configuration.',
    };
  }
  return { success: true, data: result.data };
}
