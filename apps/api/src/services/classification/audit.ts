import { eq, schema } from '@oci/db';
import type { ClassificationPoint } from '@oci/shared';
import { db } from '../../db/index.js';
import { recordAudit } from '../audit.js';
import { observeClassificationDecision } from '../observability/events.js';
import type { Decision } from './resolve.js';

/** What the decision was about, for the audit entry. Ids and kinds, never content. */
export interface DecisionContext {
  userId: string;
  point: ClassificationPoint;
  /** `model`, `web_search`, `embeddings`, `reranking`, `share`, `memory`. */
  destination: string;
  modelSlug?: string | undefined;
  toolId?: string | undefined;
  threadId?: string | undefined;
  projectId?: string | undefined;
}

const brief = (classes: Decision['classes']) =>
  classes.map((entry) => ({ id: entry.id, name: entry.name }));

async function emailOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Counts a decision and, when it warned or blocked, audits it
 * (`classification.warn`, `classification.block`). Counted only for a
 * conversation that carries at least one class. Metadata is content-free:
 * the class names as they were at the time, the point, the kind of
 * destination, the model slug and tool id; never text, titles, arguments or
 * results. Never fails what it describes (`recordAudit` does not throw; the
 * counter cannot).
 */
export async function recordDecision(decision: Decision, context: DecisionContext): Promise<void> {
  if (decision.classes.length === 0) return;
  const outcome =
    decision.outcome === 'block' ? 'blocked' : decision.outcome === 'warn' ? 'warned' : 'allowed';
  observeClassificationDecision(context.point, outcome);
  if (decision.outcome === 'allow') return;
  await recordAudit({
    actorUserId: context.userId,
    actorEmail: await emailOf(context.userId).catch(() => null),
    action: decision.outcome === 'block' ? 'classification.block' : 'classification.warn',
    targetType: context.threadId ? 'thread' : context.projectId ? 'project' : null,
    targetId: context.threadId ?? context.projectId ?? null,
    metadata: {
      point: context.point,
      mode: decision.mode,
      destination: context.destination,
      ...(context.modelSlug && { modelSlug: context.modelSlug }),
      ...(context.toolId && { toolId: context.toolId.slice(0, 200) }),
      classes: brief(decision.classes),
      missing: brief(decision.missing),
    },
  });
}
