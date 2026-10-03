import { randomUUID } from 'node:crypto';
import { schema } from '@oci/db';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { getDefaultOrganizationId } from './organization.js';
import { enqueueWebhookEvent } from './webhooks/delivery.js';

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
    // Generated here so webhook deliveries can name the entry without a read-back.
    const id = randomUUID();
    await db.insert(schema.auditLog).values({
      id,
      organizationId,
      actorUserId: event.actorUserId ?? null,
      actorEmail: event.actorEmail ?? null,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      metadata: event.metadata ?? null,
      ipAddress: event.ipAddress ?? null,
    });
    // Never throws; queues nothing when no webhook endpoint selected this action.
    await enqueueWebhookEvent({
      id,
      action: event.action,
      createdAt: new Date(),
      actorUserId: event.actorUserId ?? null,
      actorEmail: event.actorEmail ?? null,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      metadata: event.metadata ?? null,
    });
  } catch (error) {
    // Auditing must never break the request it is describing.
    logger.error({ error, action: event.action }, 'Failed to write audit log entry');
  }
}
