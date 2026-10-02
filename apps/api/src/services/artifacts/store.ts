import { and, asc, desc, eq, inArray, isNull, schema, sql } from '@oci/db';
import {
  ARTIFACT_KIND_LABELS,
  type ArtifactDetail,
  type ArtifactKind,
  type ArtifactSummary,
  type ArtifactVersionDetail,
  type ArtifactVersionSource,
  type ArtifactVersionSummary,
  artifactByteLength,
  cleanArtifactTitle,
  detectArtifactBlocks,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_VERSIONS,
  MAX_ARTIFACTS_PER_THREAD,
  type UserRole,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { conflict, forbidden, notFound, validationFailed } from '../../lib/errors.js';
import { roleFeatures } from '../role-features.js';
import { formatBytes, getStorageLimits } from '../storage/quota.js';
import { admissionTotals, lockStorageUsage, type StorageTransaction } from '../storage/usage.js';

type Transaction = StorageTransaction;
type ArtifactRow = typeof schema.artifact.$inferSelect;
type Limits = Awaited<ReturnType<typeof getStorageLimits>>;

const ARTIFACTS_NOT_ALLOWED = 'Artifacts are not available for your role';

const tooLarge = () =>
  validationFailed(`An artifact can be at most ${formatBytes(MAX_ARTIFACT_BYTES)}.`);

/** The artifact's conversation is not in the trash; trashed conversations are invisible. */
const inLiveThread = () =>
  sql`exists (select 1 from ${schema.thread} where ${schema.thread.id} = ${schema.artifact.threadId} and ${schema.thread.deletedAt} is null)`;

function serializeArtifact(row: ArtifactRow, sizeBytes: number): ArtifactSummary {
  return {
    id: row.id,
    threadId: row.threadId,
    messageId: row.messageId,
    sourceKey: row.sourceKey,
    title: row.title,
    kind: row.kind,
    currentVersion: row.currentVersion,
    sizeBytes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeVersion(
  row: Pick<
    typeof schema.artifactVersion.$inferSelect,
    'version' | 'sizeBytes' | 'source' | 'messageId' | 'createdAt'
  >,
): ArtifactVersionSummary {
  return {
    version: row.version,
    sizeBytes: row.sizeBytes,
    source: row.source,
    messageId: row.messageId,
    createdAt: row.createdAt.toISOString(),
  };
}

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
async function admit(
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

async function threadArtifactCount(tx: Transaction, threadId: string): Promise<number> {
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
  content: string;
}): Promise<{ artifact: ArtifactSummary; created: boolean }> {
  const bytes = assertArtifactContent(params.content);
  const title = cleanArtifactTitle(params.title) || ARTIFACT_KIND_LABELS[params.kind];
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
    const row = await insertArtifact(tx, { ...params, title }, bytes);
    if (!row) throw conflict('The artifact was created at the same time; try again.');
    return { artifact: serializeArtifact(row, bytes), created: true };
  });
}

async function insertArtifact(
  tx: Transaction,
  params: {
    userId: string;
    threadId: string;
    messageId: string;
    sourceKey: string;
    title: string;
    kind: ArtifactKind;
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

/** The current content of an artifact the person owns, or null. */
export async function currentContent(
  artifactId: string,
  userId: string,
): Promise<{ artifact: ArtifactRow; content: string } | null> {
  const [row] = await db
    .select({ artifact: schema.artifact, content: schema.artifactVersion.content })
    .from(schema.artifact)
    .innerJoin(
      schema.artifactVersion,
      and(
        eq(schema.artifactVersion.artifactId, schema.artifact.id),
        eq(schema.artifactVersion.version, schema.artifact.currentVersion),
      ),
    )
    .where(
      and(eq(schema.artifact.id, artifactId), eq(schema.artifact.userId, userId), inLiveThread()),
    )
    .limit(1);
  return row ?? null;
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

/** Every artifact of a conversation the caller has already checked is theirs. */
export async function listThreadArtifacts(
  threadId: string,
  userId: string,
): Promise<ArtifactSummary[]> {
  const rows = await db
    .select({ artifact: schema.artifact, sizeBytes: schema.artifactVersion.sizeBytes })
    .from(schema.artifact)
    .innerJoin(
      schema.artifactVersion,
      and(
        eq(schema.artifactVersion.artifactId, schema.artifact.id),
        eq(schema.artifactVersion.version, schema.artifact.currentVersion),
      ),
    )
    .where(and(eq(schema.artifact.threadId, threadId), eq(schema.artifact.userId, userId)))
    .orderBy(asc(schema.artifact.createdAt), asc(schema.artifact.id));
  return rows.map((row) => serializeArtifact(row.artifact, row.sizeBytes));
}

/** An artifact with its versions, newest first, and current content. 404 for anyone but its owner. */
export async function getArtifactDetail(
  artifactId: string,
  userId: string,
): Promise<ArtifactDetail> {
  const current = await currentContent(artifactId, userId);
  if (!current) throw notFound('Artifact not found');
  const versions = await db
    .select({
      version: schema.artifactVersion.version,
      sizeBytes: schema.artifactVersion.sizeBytes,
      source: schema.artifactVersion.source,
      messageId: schema.artifactVersion.messageId,
      createdAt: schema.artifactVersion.createdAt,
    })
    .from(schema.artifactVersion)
    .where(eq(schema.artifactVersion.artifactId, artifactId))
    .orderBy(desc(schema.artifactVersion.version));
  const summary = serializeArtifact(
    current.artifact,
    versions.find((version) => version.version === current.artifact.currentVersion)?.sizeBytes ?? 0,
  );
  return { artifact: summary, versions: versions.map(serializeVersion), content: current.content };
}

export async function getArtifactVersion(
  artifactId: string,
  userId: string,
  version: number,
): Promise<ArtifactVersionDetail> {
  const [row] = await db
    .select({ version: schema.artifactVersion })
    .from(schema.artifactVersion)
    .innerJoin(schema.artifact, eq(schema.artifact.id, schema.artifactVersion.artifactId))
    .where(
      and(
        eq(schema.artifact.id, artifactId),
        eq(schema.artifact.userId, userId),
        eq(schema.artifactVersion.version, version),
        inLiveThread(),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Artifact version not found');
  return { ...serializeVersion(row.version), content: row.version.content };
}

/**
 * One version of an artifact the person owns (the current one when `version`
 * is omitted), with what a file export needs; null when there is none or the
 * conversation is in the trash.
 */
export async function artifactVersionForExport(
  artifactId: string,
  userId: string,
  version?: number,
): Promise<{
  id: string;
  threadId: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  content: string;
} | null> {
  const [row] = await db
    .select({
      id: schema.artifact.id,
      threadId: schema.artifact.threadId,
      title: schema.artifact.title,
      kind: schema.artifact.kind,
      version: schema.artifactVersion.version,
      content: schema.artifactVersion.content,
    })
    .from(schema.artifact)
    .innerJoin(
      schema.artifactVersion,
      and(
        eq(schema.artifactVersion.artifactId, schema.artifact.id),
        version === undefined
          ? eq(schema.artifactVersion.version, schema.artifact.currentVersion)
          : eq(schema.artifactVersion.version, version),
      ),
    )
    .where(
      and(eq(schema.artifact.id, artifactId), eq(schema.artifact.userId, userId), inLiveThread()),
    )
    .limit(1);
  return row ?? null;
}

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

/**
 * The artifacts the model may update in this conversation, newest first:
 * those of replies still on the conversation's path.
 */
export async function artifactsForPrompt(threadId: string, userId: string, limit = 20) {
  return db
    .select({
      id: schema.artifact.id,
      title: schema.artifact.title,
      kind: schema.artifact.kind,
      currentVersion: schema.artifact.currentVersion,
    })
    .from(schema.artifact)
    .innerJoin(schema.message, eq(schema.message.id, schema.artifact.messageId))
    .where(
      and(
        eq(schema.artifact.threadId, threadId),
        eq(schema.artifact.userId, userId),
        isNull(schema.message.supersededAt),
      ),
    )
    .orderBy(desc(schema.artifact.updatedAt), desc(schema.artifact.id))
    .limit(limit);
}

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
