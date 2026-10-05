import { and, asc, eq, inArray, schema } from '@oci/db';
import { db } from '../../db/index.js';
import type { Transaction } from './rows.js';

export { replyText, saveDetectedArtifacts } from './detection.js';
export {
  addArtifactVersion,
  assertArtifactsAllowed,
  createArtifact,
  editArtifact,
} from './mutations.js';
export {
  artifactsForPrompt,
  artifactVersionForExport,
  currentContent,
  getArtifactDetail,
  getArtifactVersion,
  listThreadArtifacts,
} from './queries.js';

/**
 * A fork or edit copies the artifacts its copied replies created, with the
 * versions made by copied replies or by the person (renumbered from 1), so the
 * new conversation shows the same cards. `copied` maps source message ids to
 * their copies. Copies count towards storage like any other artifact.
 */
export async function copyArtifactsToFork(
  tx: Transaction,
  input: { sourceThreadId: string; threadId: string; userId: string; copied: Map<string, string> },
): Promise<void> {
  if (input.copied.size === 0) return;
  const sources = await tx
    .select()
    .from(schema.artifact)
    .where(
      and(
        eq(schema.artifact.threadId, input.sourceThreadId),
        inArray(schema.artifact.messageId, [...input.copied.keys()]),
      ),
    )
    .orderBy(asc(schema.artifact.createdAt), asc(schema.artifact.id));
  for (const source of sources) {
    const versions = (
      await tx
        .select()
        .from(schema.artifactVersion)
        .where(eq(schema.artifactVersion.artifactId, source.id))
        .orderBy(asc(schema.artifactVersion.version))
    ).filter(
      (version) =>
        version.source === 'person' ||
        (version.messageId !== null && input.copied.has(version.messageId)),
    );
    if (versions.length === 0) continue;
    const [copy] = await tx
      .insert(schema.artifact)
      .values({
        userId: input.userId,
        threadId: input.threadId,
        messageId: input.copied.get(source.messageId)!,
        sourceKey: source.sourceKey,
        title: source.title,
        kind: source.kind,
        currentVersion: versions.length,
        createdAt: source.createdAt,
      })
      .returning({ id: schema.artifact.id });
    if (!copy) continue;
    await tx.insert(schema.artifactVersion).values(
      versions.map((version, index) => ({
        artifactId: copy.id,
        version: index + 1,
        content: version.content,
        sizeBytes: version.sizeBytes,
        source: version.source,
        messageId: version.messageId ? (input.copied.get(version.messageId) ?? null) : null,
        createdAt: version.createdAt,
      })),
    );
  }
}

/** Artifacts created by `messageIds`, with every version, for exports. */
export async function artifactsWithVersions(
  threadId: string,
  userId: string,
  messageIds: readonly string[],
) {
  if (messageIds.length === 0) return [];
  const artifacts = await db
    .select()
    .from(schema.artifact)
    .where(
      and(
        eq(schema.artifact.threadId, threadId),
        eq(schema.artifact.userId, userId),
        inArray(schema.artifact.messageId, [...messageIds]),
      ),
    )
    .orderBy(asc(schema.artifact.createdAt), asc(schema.artifact.id));
  if (artifacts.length === 0) return [];
  const versions = await db
    .select()
    .from(schema.artifactVersion)
    .where(
      inArray(
        schema.artifactVersion.artifactId,
        artifacts.map((artifact) => artifact.id),
      ),
    )
    .orderBy(asc(schema.artifactVersion.version));
  return artifacts.map((artifact) => ({
    ...artifact,
    versions: versions.filter((version) => version.artifactId === artifact.id),
  }));
}
