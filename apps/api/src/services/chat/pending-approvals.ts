import { and, eq, ne, schema, sql } from '@oci/db';
import { APPROVAL_NOT_ANSWERED, isToolPart, toolIdOfPart } from '@oci/shared';
import { recordToolCall } from '../tools/audit.js';
import type { ChatTransaction } from './thread-claim.js';

type Part = Record<string, unknown>;

/** Parts of a reply that still wait for an answer, or were answered but never ran. */
const openApprovalCondition = () =>
  sql<boolean>`${schema.message.parts} @? '$[*] ? (@.state == "approval-requested" || @.state == "approval-responded")'`;

export function openApprovals(
  parts: readonly unknown[],
): Array<Part & { approval: { id: string } }> {
  return parts.filter(
    (part): part is Part & { approval: { id: string } } =>
      isToolPart(part) &&
      part.state === 'approval-requested' &&
      typeof (part.approval as { id?: unknown } | undefined)?.id === 'string',
  );
}

/**
 * Settles every open approval: an unanswered one becomes a denial with the
 * reason "not answered", and an approved step that never ran becomes a failed
 * step. The model then never sees a dangling call.
 */
export function settleOpenApprovals(parts: readonly unknown[]) {
  const unanswered: string[] = [];
  const settled = parts.map((part) => {
    if (!isToolPart(part)) return part;
    const approval = (part.approval ?? {}) as Record<string, unknown>;
    if (part.state === 'approval-requested') {
      unanswered.push(toolIdOfPart(part));
      return {
        ...part,
        state: 'output-denied',
        approval: { ...approval, approved: false, reason: APPROVAL_NOT_ANSWERED },
      };
    }
    if (part.state === 'approval-responded') {
      return approval.approved === true
        ? { ...part, state: 'output-error', errorText: 'This step did not run.' }
        : { ...part, state: 'output-denied' };
    }
    return part;
  });
  return { parts: settled, unanswered };
}

/**
 * Called under the thread lock when a new message is sent: denies every
 * unanswered approval in the conversation. Returns what to audit once the
 * transaction has committed.
 */
export async function denyOpenApprovals(
  tx: ChatTransaction,
  threadId: string,
  userId: string,
  exceptMessageId?: string,
) {
  const rows = await tx
    .select({ id: schema.message.id, parts: schema.message.parts })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.threadId, threadId),
        eq(schema.message.userId, userId),
        eq(schema.message.role, 'assistant'),
        ne(schema.message.status, 'streaming'),
        exceptMessageId ? ne(schema.message.id, exceptMessageId) : undefined,
        openApprovalCondition(),
      ),
    );
  const audits: Array<{ messageId: string; toolId: string }> = [];
  for (const row of rows) {
    const { parts, unanswered } = settleOpenApprovals(row.parts);
    await tx
      .update(schema.message)
      .set({ parts: parts as Record<string, unknown>[], updatedAt: new Date() })
      .where(eq(schema.message.id, row.id));
    for (const toolId of unanswered) audits.push({ messageId: row.id, toolId });
  }
  return async () => {
    for (const audit of audits)
      await recordToolCall({
        userId,
        toolId: audit.toolId,
        kind: 'write',
        threadId,
        messageId: audit.messageId,
        outcome: 'denied',
        approvalRequired: true,
        approval: 'not answered',
        durationMs: null,
        resultBytes: null,
      });
  };
}
