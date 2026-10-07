import { and, eq, isNull, schema, sql } from '@oci/db';
import {
  type ArtifactKind,
  type ArtifactSummary,
  type ArtifactVersionSource,
  artifactByteLength,
  artifactKindLabel,
  cleanArtifactTitle,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_VERSIONS,
  MAX_ARTIFACTS_PER_THREAD,
  normalizeCodeLanguage,
  type UserRole,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { roleFeatures } from '../role-features.js';
import { formatBytes, getStorageLimits } from '../storage/quota.js';
import { admissionTotals, lockStorageUsage } from '../storage/usage.js';
import { type ArtifactRow, type Limits, serializeArtifact, type Transaction } from './rows.js';

const ARTIFACTS_NOT_ALLOWED = 'Artifacts are not available for your role';

const tooLarge = () =>
  validationFailed(`An artifact can be at most ${formatBytes(MAX_ARTIFACT_BYTES)}.`);

/** Refuses content OCI will not store; `content` is checked in UTF-8 bytes. */
function assertArtifactContent(content: string): number {
  if (!content.trim()) throw validationFailed('An artifact cannot be empty.');
  const bytes = artifactByteLength(content);
  if (bytes > MAX_ARTIFACT_BYTES) throw tooLarge();
  return bytes;
}

/**
 * Locks, in the order every lifecycle path uses (thread, then the storage
 * row), and checks that `incoming` more bytes fit the person's allowance.
 * Artifacts add bytes but no files.
 */
export async function admit(
  tx: Transaction,
  owner: { userId: string; threadId: string },
  limits: Limits,
  incoming: number,
): Promise<{ organizationId: string } | null> {
  const [thread] = await tx
    .select({ organizationId: schema.thread.organizationId })
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.id, owner.threadId),
        eq(schema.thread.userId, owner.userId),
        isNull(schema.thread.deletedAt),
      ),
    )
    .limit(1)
    .for('share');
  if (!thread) return null;
  await lockStorageUsage(tx, { organizationId: thread.organizationId, userId: owner.userId });
  if (limits.maxTotalBytes !== null && incoming > 0) {
    const totals = await admissionTotals(tx, owner.userId);
    if (totals.liveBytes + incoming > limits.maxTotalBytes) {
      const free = Math.max(0, limits.maxTotalBytes - totals.liveBytes);
      throw validationFailed(
        `Saving this artifact would exceed your ${formatBytes(limits.maxTotalBytes)} storage limit ` +
          `(${formatBytes(free)} free). Delete files or conversations to make room.`,
      );
    }
  }
  return thread;
}

export async function threadArtifactCount(tx: Transaction, threadId: string): Promise<number> {
  const [row] = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(schema.artifact)
    .where(eq(schema.artifact.threadId, threadId));
  return Number(row?.value ?? 0);
}

export async function assertArtifactsAllowed(role: UserRole): Promise<void> {
  if (!(await roleFeatures(role)).artifacts) throw forbidden(ARTIFACTS_NOT_ALLOWED);
}

/**
 * Creates an artifact with its first version, made by `messageId`. Returns the
 * existing artifact (not a new version) when this reply already created one
 * from the same source, so a repeated call is harmless.
 */
export async function createArtifact(params: {
  userId: string;
  role: UserRole;
  threadId: string;
  messageId: string;
  sourceKey: string;
  title: string;
  kind: ArtifactKind;
  /** A code artifact's language (#298); ignored for the other kinds. */
  language?: string | null;
  content: string;
}): Promise<{ artifact: ArtifactSummary; created: boolean }> {
  const bytes = assertArtifactContent(params.content);
  const language = params.kind === 'code' ? normalizeCodeLanguage(params.language) : null;
  const title = cleanArtifactTitle(params.title) || artifactKindLabel(params.kind, language);
  const limits = await getStorageLimits(params.role);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.artifact)
      .where(
        and(
          eq(schema.artifact.messageId, params.messageId),
          eq(schema.artifact.sourceKey, params.sourceKey),
          eq(schema.artifact.userId, params.userId),
        ),
      )
      .limit(1);
    if (existing) return { artifact: await summaryOf(tx, existing), created: false };
    if (!(await admit(tx, params, limits, bytes))) throw notFound('Conversation not found');
    if ((await threadArtifactCount(tx, params.threadId)) >= MAX_ARTIFACTS_PER_THREAD)
      throw validationFailed(
        `A conversation can hold at most ${MAX_ARTIFACTS_PER_THREAD} artifacts. Update an existing one instead.`,
      );
    const row = await insertArtifact(tx, { ...params, title, language }, bytes);
    if (!row) throw conflict('The artifact was created at the same time; try again.');
    return { artifact: serializeArtifact(row, bytes), created: true };
  });
}

export async function insertArtifact(
  tx: Transaction,
  params: {
    userId: string;
    threadId: string;
    messageId: string;
    sourceKey: string;
    title: string;
    kind: ArtifactKind;
    language?: string | null;
    content: string;
  },
  bytes: number,
): Promise<ArtifactRow | null> {
  const [row] = await tx
    .insert(schema.artifact)
    .values({
      userId: params.userId,
      threadId: params.threadId,
      messageId: params.messageId,
      sourceKey: params.sourceKey,
      title: params.title,
      kind: params.kind,
      language: params.language ?? null,
      currentVersion: 1,
    })
    .onConflictDoNothing({ target: [schema.artifact.messageId, schema.artifact.sourceKey] })
    .returning();
  if (!row) return null;
  await tx.insert(schema.artifactVersion).values({
    artifactId: row.id,
    version: 1,
    content: params.content,
    sizeBytes: bytes,
    source: 'reply',
    messageId: params.messageId,
  });
  return row;
}

async function summaryOf(tx: Pick<Transaction, 'select'>, row: ArtifactRow) {
  const [current] = await tx
    .select({ sizeBytes: schema.artifactVersion.sizeBytes })
    .from(schema.artifactVersion)
    .where(
      and(
        eq(schema.artifactVersion.artifactId, row.id),
        eq(schema.artifactVersion.version, row.currentVersion),
      ),
    )
    .limit(1);
  return serializeArtifact(row, current?.sizeBytes ?? 0);
}

/**
 * Adds a version. `baseVersion`, when given, must still be the current one
 * (409 otherwise), so an edit made from an older version never silently
 * replaces a newer one.
 */
export async function addArtifactVersion(params: {
  artifactId: string;
  userId: string;
  role: UserRole;
  content: string;
  source: ArtifactVersionSource;
  messageId: string | null;
  /** Limits the change to artifacts of this conversation (tools). */
  threadId?: string;
  baseVersion?: number;
  title?: string;
}): Promise<ArtifactSummary> {
  const bytes = assertArtifactContent(params.content);
  const limits = await getStorageLimits(params.role);
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ threadId: schema.artifact.threadId })
      .from(schema.artifact)
      .where(
        and(
          eq(schema.artifact.id, params.artifactId),
          eq(schema.artifact.userId, params.userId),
          ...(params.threadId ? [eq(schema.artifact.threadId, params.threadId)] : []),
        ),
      )
      .limit(1);
    if (!owned) throw notFound('Artifact not found');
    if (!(await admit(tx, { userId: params.userId, threadId: owned.threadId }, limits, bytes)))
      throw notFound('Artifact not found');
    const [row] = await tx
      .select()
      .from(schema.artifact)
      .where(eq(schema.artifact.id, params.artifactId))
      .limit(1)
      .for('update');
    if (!row) throw notFound('Artifact not found');
    if (params.baseVersion !== undefined && params.baseVersion !== row.currentVersion)
      throw conflict(
        `This artifact changed since you opened it (now version ${row.currentVersion}). Reload it and edit again.`,
      );
    if (row.currentVersion >= MAX_ARTIFACT_VERSIONS)
      throw validationFailed(
        `An artifact can have at most ${MAX_ARTIFACT_VERSIONS} versions. Create a new artifact instead.`,
      );
    const version = row.currentVersion + 1;
    await tx.insert(schema.artifactVersion).values({
      artifactId: row.id,
      version,
      content: params.content,
      sizeBytes: bytes,
      source: params.source,
      messageId: params.messageId,
    });
    const title = params.title ? cleanArtifactTitle(params.title) : '';
    const [updated] = await tx
      .update(schema.artifact)
      .set({ currentVersion: version, updatedAt: new Date(), ...(title ? { title } : {}) })
      .where(eq(schema.artifact.id, row.id))
      .returning();
    return serializeArtifact(updated ?? row, bytes);
  });
}

/** A person's edit of a Markdown document: a new version. */
export async function editArtifact(
  artifactId: string,
  user: { id: string; role: UserRole },
  input: { content: string; baseVersion: number },
): Promise<ArtifactSummary> {
  const [row] = await db
    .select({ kind: schema.artifact.kind })
    .from(schema.artifact)
    .where(and(eq(schema.artifact.id, artifactId), eq(schema.artifact.userId, user.id)))
    .limit(1);
  if (!row) throw notFound('Artifact not found');
  await assertArtifactsAllowed(user.role);
  if (row.kind !== 'markdown')
    throw validationFailed(
      'Only documents can be edited directly. Ask the model to change this one.',
    );
  return addArtifactVersion({
    artifactId,
    userId: user.id,
    role: user.role,
    content: input.content,
    source: 'person',
    messageId: null,
    baseVersion: input.baseVersion,
  });
}
