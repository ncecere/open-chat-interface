import type { ToolKind } from '@oci/shared';
import { recordAudit } from '../audit.js';

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
  await recordAudit({
    actorUserId: event.userId,
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
