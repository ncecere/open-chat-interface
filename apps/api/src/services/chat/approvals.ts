import { and, eq, gt, schema } from '@oci/db';
import {
  type AnswerToolApprovalsInput,
  isToolPart,
  type SendMessageInput,
  toolIdOfPart,
} from '@oci/shared';
import type { UIMessage } from 'ai';
import { db } from '../../db/index.js';
import { conflict, notFound, rateLimited, validationFailed } from '../../lib/errors.js';
import { beginChatRun } from '../chat-streams.js';
import { acquireStreamSlot } from '../limits/concurrency.js';
import { resolveModelForRole } from '../models.js';
import { releaseReservation, reserveQuotaForRun } from '../quota/index.js';
import { assertTemporaryChatAllowed, getOwnedThread } from '../threads.js';
import { hasTool, resolveTurnTools } from '../tools/registry.js';
import {
  addCost,
  assertFitsContext,
  contextBudget,
  messageCost,
  textCost,
} from './context-budget.js';
import { textParts } from './message-parts.js';
import { buildModelContext } from './model-context.js';
import { openApprovals } from './pending-approvals.js';
import type { PreparedTurn } from './prepare-turn.js';
import { failRunSetup, type RunResources, releaseRunHandles } from './run-cleanup.js';
import type { AcquiredRun } from './run-lifecycle.js';
import { lockChatThread } from './thread-claim.js';
import { maxToolSteps } from './tool-loop.js';
import type { TurnContext } from './turn-context.js';

const NOT_PENDING = 'This reply is not waiting for that approval.';
const NOT_LATEST = 'Only the latest reply can be approved.';

type StoredReply = typeof schema.message.$inferSelect;
type Part = Record<string, unknown>;

/**
 * Applies the person's answers to a reply's open approvals. Every open
 * approval must be answered, and only those. An approved call to a tool no
 * longer offered (its role or instance switch changed) is denied instead and
 * recorded as refused.
 */
function answerParts(
  parts: readonly unknown[],
  responses: AnswerToolApprovalsInput['responses'],
  offered: (toolId: string) => boolean,
) {
  const open = openApprovals(parts);
  const answers = new Map(responses.map((response) => [response.approvalId, response.approved]));
  if (
    open.length === 0 ||
    answers.size !== responses.length ||
    open.length !== answers.size ||
    open.some((part) => !answers.has(part.approval.id))
  )
    throw validationFailed(NOT_PENDING);
  const approved = new Set<string>();
  const refused = new Set<string>();
  const next = parts.map((part) => {
    if (!isToolPart(part) || part.state !== 'approval-requested') return part;
    const approval = part.approval as Part & { id: string };
    const toolId = toolIdOfPart(part);
    let answer = answers.get(approval.id) === true;
    if (answer && !offered(toolId)) {
      answer = false;
      refused.add(part.toolCallId);
    } else if (answer) approved.add(part.toolCallId);
    return {
      ...part,
      state: 'approval-responded',
      approval: {
        ...approval,
        approved: answer,
        ...(answer
          ? {}
          : { reason: refused.has(part.toolCallId) ? 'tool no longer available' : 'denied' }),
      },
    };
  });
  return { parts: next as Part[], approved, refused };
}

/**
 * Re-claims a reply that waits on approvals and prepares the same assistant
 * message to continue: the durable claim (`streaming`), a stream slot, a
 * resumable stream and a usage reservation, as for a new reply.
 */
export async function setupApprovalContinuation(
  user: TurnContext['user'],
  threadId: string,
  body: AnswerToolApprovalsInput,
): Promise<{ turn: PreparedTurn; run: AcquiredRun }> {
  const thread = await getOwnedThread(threadId, user.id);
  if (thread.temporary) await assertTemporaryChatAllowed(user.role);
  const [reply] = await db
    .select()
    .from(schema.message)
    .where(
      and(
        eq(schema.message.id, body.messageId),
        eq(schema.message.threadId, thread.id),
        eq(schema.message.userId, user.id),
        eq(schema.message.role, 'assistant'),
      ),
    )
    .limit(1);
  if (!reply) throw notFound('Reply not found');
  if (!reply.modelSlug || !reply.parentMessageId) throw validationFailed(NOT_PENDING);
  const resolved = await resolveModelForRole(reply.modelSlug, user.role);
  const tools = await resolveTurnTools({
    role: user.role,
    capabilities: resolved.capabilities,
    webSearch: reply.webSearchUsed,
  });
  const [prompt] = await db
    .select({ parts: schema.message.parts })
    .from(schema.message)
    .where(
      and(eq(schema.message.id, reply.parentMessageId), eq(schema.message.threadId, thread.id)),
    )
    .limit(1);
  if (!prompt) throw validationFailed(NOT_PENDING);
  const input: SendMessageInput = {
    threadId: thread.id,
    modelSlug: resolved.slug,
    ...(reply.effort ? { effort: reply.effort } : {}),
    // The search switch belongs to the message; with the tool it never searches up front.
    webSearch: reply.webSearchUsed && hasTool(tools, 'web_search'),
    attachmentIds: [],
    temporary: thread.temporary,
    trigger: 'regenerate-message',
    messages: [{ id: reply.parentMessageId, role: 'user', parts: textParts(prompt.parts) }],
  };
  const context: TurnContext = { user, input, thread, resolved, tools };

  const runIdentity = {
    runId: `${reply.id}:${crypto.randomUUID().slice(0, 8)}`,
    threadId: thread.id,
    userId: user.id,
  };
  const streamSlot = await acquireStreamSlot(user.id, user.role, runIdentity.runId);
  if (!streamSlot)
    throw rateLimited(
      'You have too many responses generating at once. Wait for one to finish and try again.',
    );
  const resources: RunResources = {
    runIdentity,
    streamSlot,
    persistence: 'unavailable',
    reservation: null,
    // The message already exists: a failure must never delete it.
    turnPersisted: true,
  };
  let claimed: { before: StoredReply; answered: ReturnType<typeof answerParts> } | null = null;
  try {
    claimed = await db.transaction(async (tx) => {
      await lockChatThread(tx, thread.id, user.id);
      const [active] = await tx
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.threadId, thread.id),
            eq(schema.message.role, 'assistant'),
            eq(schema.message.status, 'streaming'),
          ),
        )
        .limit(1);
      if (active) throw conflict('A response is already being generated for this thread');
      const [current] = await tx
        .select()
        .from(schema.message)
        .where(and(eq(schema.message.id, reply.id), eq(schema.message.threadId, thread.id)))
        .for('update');
      if (!current) throw notFound('Reply not found');
      const [later] = await tx
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.threadId, thread.id),
            eq(schema.message.role, 'user'),
            gt(schema.message.position, current.position),
          ),
        )
        .limit(1);
      if (later || current.supersededAt !== null) throw validationFailed(NOT_LATEST);
      if (current.status !== 'complete') throw validationFailed(NOT_PENDING);
      const answered = answerParts(current.parts, body.responses, (toolId) =>
        hasTool(tools, toolId),
      );
      await tx
        .update(schema.message)
        .set({
          parts: answered.parts,
          status: 'streaming',
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.message.id, current.id));
      return { before: current, answered };
    });
    resources.assistantMessage = { id: reply.id };
    const persistence = await beginChatRun(runIdentity, { admission: 'durable' });
    resources.persistence = persistence === 'available' ? 'available' : 'unavailable';
    resources.reservation = await reserveQuotaForRun({
      userId: user.id,
      role: user.role,
      modelSlug: resolved.slug,
      runId: runIdentity.runId,
      messageCount: 0,
    });

    const [model, steps] = await Promise.all([
      buildModelContext(context, reply.id),
      maxToolSteps(),
    ]);
    const continuing: UIMessage = {
      id: reply.id,
      role: 'assistant',
      parts: claimed.answered.parts as UIMessage['parts'],
    };
    const budget = contextBudget({ ...resolved, maxOutputTokens: model.outputTokens });
    assertFitsContext(
      [...model.uiMessages, continuing].reduce(
        (sum, message) => addCost(sum, messageCost(message)),
        textCost(model.system),
      ),
      budget,
    );
    return {
      turn: {
        ...context,
        resolved: { ...resolved, maxOutputTokens: model.outputTokens },
        promptMessageId: reply.parentMessageId,
        submittedMessageId: null,
        uiMessages: [...model.uiMessages, continuing],
        system: model.system,
        contextLimited: model.contextLimited,
        generationSettings: model.generationSettings,
        maxToolSteps: steps,
        sourceParts: [],
        searchGroundingPart: null,
        continuation: {
          approved: claimed.answered.approved,
          refused: claimed.answered.refused,
          existingParts: claimed.answered.parts,
        },
      },
      run: {
        ...resources,
        startedAt: Date.now(),
        assistantMessage: { id: reply.id },
        reservation: resources.reservation,
      },
    };
  } catch (error) {
    await restoreReply(resources, claimed?.before ?? null);
    throw error;
  }
}

/** Undo a continuation that never reached the model: the reply waits again. */
async function restoreReply(resources: RunResources, before: StoredReply | null) {
  if (!before) {
    await releaseRunHandles(resources, true);
    return;
  }
  try {
    await db
      .update(schema.message)
      .set({ parts: before.parts, status: before.status, errorMessage: before.errorMessage })
      .where(and(eq(schema.message.id, before.id), eq(schema.message.status, 'streaming')));
  } catch {
    // Fall through: failRunSetup marks the claim failed rather than leaving it streaming.
    await failRunSetup(resources);
    return;
  }
  await releaseRunHandles(resources, true);
  if (resources.reservation) await releaseReservation(resources.reservation).catch(() => undefined);
}
