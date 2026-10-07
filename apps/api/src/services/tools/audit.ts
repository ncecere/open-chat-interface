import { eq, schema } from '@oci/db';
import type { ToolKind } from '@oci/shared';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { recordAudit } from '../audit.js';
import { observeToolCall } from '../observability/events.js';

type ToolCallOutcome = 'ok' | 'error' | 'denied' | 'refused';
export type ToolApprovalAnswer = 'approved' | 'denied' | 'not answered';

/**
 * One `tool.call` audit event. Metadata only: inputs and outputs live in the
 * conversation and follow its retention, so a temporary chat's content never
 * outlives it through the audit log.
 */
export async function recordToolCall(event: {
  userId: string;
  toolId: string;
  kind: ToolKind | null;
  threadId: string;
  messageId: string;
  outcome: ToolCallOutcome;
  approvalRequired: boolean;
  approval: ToolApprovalAnswer | null;
  durationMs: number | null;
  resultBytes: number | null;
}): Promise<void> {
  observeToolCall(event.toolId, event.outcome, event.durationMs);
  await recordAudit({
    actorUserId: event.userId,
    actorEmail: await actorEmail(event.userId),
    action: 'tool.call',
    targetType: 'tool',
    targetId: event.toolId.slice(0, 200),
    metadata: {
      toolId: event.toolId.slice(0, 200),
      kind: event.kind,
      approvalRequired: event.approvalRequired,
      approval: event.approval,
      outcome: event.outcome,
      durationMs: event.durationMs,
      resultBytes: event.resultBytes,
      threadId: event.threadId,
      messageId: event.messageId,
    },
  });
}

/**
 * The person's email, as every other entry records its actor's (#280): tool
 * calls carried only the ID, which the audit log showed as the actor. The
 * call sites know the person by ID alone. Never fails the call it describes.
 */
async function actorEmail(userId: string): Promise<string | null> {
  try {
    const [user] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1);
    return user?.email ?? null;
  } catch (error) {
    logger.warn({ error }, 'Could not read the email of a tool call’s actor');
    return null;
  }
}
