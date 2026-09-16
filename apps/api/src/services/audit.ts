import { schema } from '@oci/db';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { getDefaultOrganizationId } from './organization.js';

export interface AuditEvent {
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    const organizationId = await getDefaultOrganizationId();
    await db.insert(schema.auditLog).values({
      organizationId,
      actorUserId: event.actorUserId ?? null,
      actorEmail: event.actorEmail ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      metadata: event.metadata ?? null,
      ipAddress: event.ipAddress ?? null,
    });
  } catch (error) {
    // Auditing must never break the request it is describing.
    logger.error({ error, action: event.action }, 'Failed to write audit log entry');
  }
}
