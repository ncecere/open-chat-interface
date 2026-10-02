import { APPROVAL_NOT_ANSWERED, isToolPart } from '@oci/shared';
import type { UIMessage } from 'ai';

type Part = UIMessage['parts'][number];

/**
 * The person's answers on a reply, ready for `POST /api/chat/:id/approvals`.
 * Empty unless the message is an assistant reply with answered approvals.
 */
export function approvalResponsesOf(
  message: UIMessage | undefined,
): Array<{ approvalId: string; approved: boolean }> {
  if (message?.role !== 'assistant') return [];
  return message.parts.flatMap((part) => {
    if (!isToolPart(part) || part.state !== 'approval-responded') return [];
    const approval = part.approval as { id?: unknown; approved?: unknown; isAutomatic?: unknown };
    if (typeof approval?.id !== 'string' || typeof approval.approved !== 'boolean') return [];
    if (approval.isAutomatic === true) return [];
    return [{ approvalId: approval.id, approved: approval.approved }];
  });
}

/** Whether any reply still waits for the person's answer. */
export function hasOpenApproval(messages: UIMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.parts.some((part) => isToolPart(part) && part.state === 'approval-requested'),
  );
}

/**
 * Mirrors the server: sending a new message denies every unanswered approval
 * with the reason "not answered". Unchanged messages keep their identity.
 */
export function denyUnansweredApprovals(messages: UIMessage[]): UIMessage[] {
  if (!hasOpenApproval(messages)) return messages;
  return messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (!message.parts.some((part) => isToolPart(part) && part.state === 'approval-requested'))
      return message;
    return {
      ...message,
      parts: message.parts.map((part): Part => {
        if (!isToolPart(part) || part.state !== 'approval-requested') return part;
        return {
          ...part,
          state: 'output-denied',
          approval: {
            ...(part.approval as { id: string }),
            approved: false,
            reason: APPROVAL_NOT_ANSWERED,
          },
        } as Part;
      }),
    };
  });
}
