import { desc, eq, schema } from '@oci/db';
import { claimMappingsSchema, createSsoProviderSchema, type SsoProviderSummary } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { auth } from '../../auth/index.js';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getDefaultOrganizationId } from '../../services/organization.js';

export const ssoRoutes = new Hono<AppBindings>();

const env = loadEnv();

function callbackUrl(providerId: string, kind: 'oidc' | 'saml'): string {
  return kind === 'saml'
    ? `${env.APP_URL}/api/auth/sso/saml2/sp/acs/${providerId}`
    : `${env.APP_URL}/api/auth/sso/callback/${providerId}`;
}

function metadataUrl(providerId: string, kind: 'oidc' | 'saml'): string | null {
  return kind === 'saml'
    ? `${env.APP_URL}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`
    : null;
}

ssoRoutes.get('/providers', async (c) => {
  const rows = await db
    .select()
    .from(schema.ssoProvider)
    .orderBy(desc(schema.ssoProvider.createdAt));

  const providers: SsoProviderSummary[] = rows.map((row) => {
    const kind = row.kind === 'saml' ? 'saml' : 'oidc';
    return {
      id: row.id,
      providerId: row.providerId,
      label: row.label || row.providerId,
      kind,
      enabled: row.enabled,
      jitProvisioning: row.jitProvisioning,
      trustedForLinking: row.trustedForLinking,
      allowedDomains: row.allowedDomains,
      defaultRole: row.defaultRole as SsoProviderSummary['defaultRole'],
      claimRoleMappings: row.claimRoleMappings,
      requireRoleMatch: row.requireRoleMatch,
      roleRequiredMessage: row.roleRequiredMessage,
      claimMappings: row.claimMappings,
      autoRedirect: row.autoRedirect,
      issuer: row.issuer,
      metadataUrl: metadataUrl(row.providerId, kind),
      callbackUrl: callbackUrl(row.providerId, kind),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  return c.json({ providers });
});

ssoRoutes.post('/providers', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, createSsoProviderSchema);
  const organizationId = await getDefaultOrganizationId();

  const [existing] = await db
    .select({ id: schema.ssoProvider.id })
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.providerId, input.providerId))
    .limit(1);

  if (existing) throw conflict('A provider with that ID already exists');

  const domain = input.allowedDomains[0] ?? 'localhost';

  if (input.kind === 'oidc') {
    await auth.api.registerSSOProvider({
      body: {
        providerId: input.providerId,
        issuer: input.issuer,
        domain,
        oidcConfig: {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          discoveryEndpoint:
            input.discoveryUrl ??
            `${input.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
          scopes: input.scopes,
          pkce: input.pkce,
        },
      },
      headers: c.req.raw.headers,
    });
  } else {
    await auth.api.registerSSOProvider({
      body: {
        providerId: input.providerId,
        issuer: input.issuer,
        domain,
        samlConfig: {
          entryPoint: input.entryPoint,
          cert: input.idpCertificate,
          callbackUrl: callbackUrl(input.providerId, 'saml'),
          audience: input.audience ?? env.APP_URL,
          wantAssertionsSigned: input.wantAssertionsSigned,
          signatureAlgorithm: input.signatureAlgorithm,
          digestAlgorithm: input.digestAlgorithm,
          idpMetadata: {
            entityID: input.issuer,
            cert: input.idpCertificate,
            singleSignOnService: [
              {
                Location: input.entryPoint,
                Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
              },
            ],
          },
          spMetadata: {
            entityID: input.audience ?? env.APP_URL,
            binding: 'post',
          },
        },
      },
      headers: c.req.raw.headers,
    });
  }

  // Apply OCI-specific policy columns the plugin does not manage.
  await db
    .update(schema.ssoProvider)
    .set({
      organizationId,
      label: input.label,
      kind: input.kind,
      enabled: input.enabled,
      jitProvisioning: input.jitProvisioning,
      trustedForLinking: input.trustedForLinking,
      // The plugin reads domainVerified; trustedForLinking is the admin control.
      domainVerified: input.trustedForLinking,
      allowedDomains: input.allowedDomains,
      defaultRole: input.defaultRole,
      claimRoleMappings: input.claimRoleMappings,
      requireRoleMatch: input.requireRoleMatch,
      roleRequiredMessage: input.roleRequiredMessage ?? null,
      claimMappings: input.claimMappings,
      autoRedirect: input.autoRedirect,
    })
    .where(eq(schema.ssoProvider.providerId, input.providerId));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'sso.create',
    targetType: 'sso_provider',
    targetId: input.providerId,
    metadata: { kind: input.kind, label: input.label },
  });

  return c.json({ providerId: input.providerId }, 201);
});

const policyPatchSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  jitProvisioning: z.boolean().optional(),
  trustedForLinking: z.boolean().optional(),
  allowedDomains: z.array(z.string().trim().toLowerCase().max(253)).optional(),
  defaultRole: z.enum(['admin', 'user', 'restricted']).optional(),
  claimRoleMappings: z
    .array(
      z.object({
        claim: z.string().trim().min(1).max(120),
        value: z.string().trim().min(1).max(200),
        role: z.enum(['admin', 'user', 'restricted']),
      }),
    )
    .optional(),
  requireRoleMatch: z.boolean().optional(),
  roleRequiredMessage: z.string().trim().max(500).nullable().optional(),
  claimMappings: claimMappingsSchema.optional(),
  autoRedirect: z.boolean().optional(),
});

ssoRoutes.patch('/providers/:providerId', async (c) => {
  const actor = currentUser(c);
  const providerId = c.req.param('providerId');
  const patch = await parseBody(c, policyPatchSchema);

  const [existing] = await db
    .select({ id: schema.ssoProvider.id })
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.providerId, providerId))
    .limit(1);

  if (!existing) throw notFound('SSO provider not found');

  await db
    .update(schema.ssoProvider)
    .set({
      ...patch,
      ...(patch.trustedForLinking !== undefined && { domainVerified: patch.trustedForLinking }),
    })
    .where(eq(schema.ssoProvider.providerId, providerId));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'sso.update',
    targetType: 'sso_provider',
    targetId: providerId,
    metadata: patch,
  });

  return c.json({ ok: true });
});

ssoRoutes.delete('/providers/:providerId', async (c) => {
  const actor = currentUser(c);
  const providerId = c.req.param('providerId');

  await db.delete(schema.ssoProvider).where(eq(schema.ssoProvider.providerId, providerId));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'sso.delete',
    targetType: 'sso_provider',
    targetId: providerId,
  });

  return c.json({ ok: true });
});
