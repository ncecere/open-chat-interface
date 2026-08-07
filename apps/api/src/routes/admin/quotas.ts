import { and, eq, schema } from '@oci/db';
import { type RoleQuota, roleQuotaSchema, USER_ROLES } from '@oci/shared';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getDefaultOrganizationId } from '../../services/organization.js';

export const quotaRoutes = new Hono<AppBindings>();

quotaRoutes.get('/', async (c) => {
  const organizationId = await getDefaultOrganizationId();

  const rows = await db
    .select()
    .from(schema.roleQuota)
    .where(eq(schema.roleQuota.organizationId, organizationId));

  const byRole = new Map(rows.map((row) => [row.role, row]));

  const quotas: RoleQuota[] = USER_ROLES.map((role) => {
    const row = byRole.get(role);
    return {
      role,
      enabled: row?.enabled ?? false,
      maxMessagesPerWindow: row?.maxMessagesPerWindow ?? null,
      maxTokensPerWindow: row?.maxTokensPerWindow ?? null,
      windowHours: row?.windowHours ?? 24,
    };
  });

  return c.json({ quotas });
});

quotaRoutes.put('/:role', async (c) => {
  const actor = currentUser(c);
  const role = c.req.param('role');
  const input = await parseBody(c, roleQuotaSchema.omit({ role: true }));
  const organizationId = await getDefaultOrganizationId();

  await db
    .insert(schema.roleQuota)
    .values({
      organizationId,
      role: role as RoleQuota['role'],
      enabled: input.enabled,
      maxMessagesPerWindow: input.maxMessagesPerWindow,
      maxTokensPerWindow: input.maxTokensPerWindow,
      windowHours: input.windowHours,
    })
    .onConflictDoNothing();

  await db
    .update(schema.roleQuota)
    .set({
      enabled: input.enabled,
      maxMessagesPerWindow: input.maxMessagesPerWindow,
      maxTokensPerWindow: input.maxTokensPerWindow,
      windowHours: input.windowHours,
    })
    .where(
      and(
        eq(schema.roleQuota.organizationId, organizationId),
        eq(schema.roleQuota.role, role as RoleQuota['role']),
      ),
    );

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'quota.update',
    targetType: 'role',
    targetId: role,
    metadata: input,
  });

  return c.json({ ok: true });
});
