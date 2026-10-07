import { eq, schema } from '@oci/db';
import {
  artifactByteLength,
  detectArtifactBlocks,
  MAX_ARTIFACTS_PER_THREAD,
  type UserRole,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { roleFeatures } from '../role-features.js';
import { getStorageLimits } from '../storage/quota.js';
import { admissionTotals } from '../storage/usage.js';
import { admit, insertArtifact, threadArtifactCount } from './mutations.js';

/** The text a renderer reads from a message: its text parts, joined as the web client joins them. */
export function replyText(parts: readonly unknown[]): string {
  return parts
    .flatMap((part) => {
      const candidate = part as { type?: unknown; text?: unknown } | null;
      return candidate?.type === 'text' && typeof candidate.text === 'string'
        ? [candidate.text]
        : [];
    })
    .join('\n');
}

/**
 * Saves the artifact-worthy blocks of a finished reply (HTML and SVG code
 * blocks, Mermaid diagrams of a few lines) as artifacts of that reply.
 * Idempotent: blocks already saved for this reply are skipped, so a repeated
 * call (a continued reply, a retried persistence) creates nothing twice. A
 * retried reply is a new message and gets its own artifacts. Blocks that would
 * exceed the conversation's artifact limit or the person's storage stay
 * ordinary code blocks. Returns how many artifacts were created.
 */
export async function saveDetectedArtifacts(params: {
  userId: string;
  role: UserRole;
  threadId: string;
  messageId: string;
  parts: readonly unknown[];
}): Promise<number> {
  const blocks = detectArtifactBlocks(replyText(params.parts));
  if (blocks.length === 0) return 0;
  if (!(await roleFeatures(params.role)).artifacts) return 0;
  const limits = await getStorageLimits(params.role);
  return db.transaction(async (tx) => {
    if (!(await admit(tx, params, limits, 0))) return 0;
    const existing = new Set(
      (
        await tx
          .select({ sourceKey: schema.artifact.sourceKey })
          .from(schema.artifact)
          .where(eq(schema.artifact.messageId, params.messageId))
      ).map((row) => row.sourceKey),
    );
    let count = await threadArtifactCount(tx, params.threadId);
    let used =
      limits.maxTotalBytes === null ? 0 : (await admissionTotals(tx, params.userId)).liveBytes;
    let created = 0;
    for (const block of blocks) {
      if (existing.has(block.key)) continue;
      if (count >= MAX_ARTIFACTS_PER_THREAD) break;
      const bytes = artifactByteLength(block.content);
      if (limits.maxTotalBytes !== null && used + bytes > limits.maxTotalBytes) break;
      const row = await insertArtifact(
        tx,
        {
          userId: params.userId,
          threadId: params.threadId,
          messageId: params.messageId,
          sourceKey: block.key,
          title: block.title,
          kind: block.kind,
          content: block.content,
        },
        bytes,
      );
      if (!row) continue;
      count += 1;
      used += bytes;
      created += 1;
    }
    return created;
  });
}
