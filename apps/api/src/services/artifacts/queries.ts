import { and, asc, desc, eq, isNull, schema, sql } from '@oci/db';
import type {
  ArtifactDetail,
  ArtifactKind,
  ArtifactSummary,
  ArtifactVersionDetail,
} from '@oci/shared';
import { db } from '../../db/index.js';
import { notFound } from '../../lib/errors.js';
import { type ArtifactRow, inLiveThread, serializeArtifact, serializeVersion } from './rows.js';

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
  language: string | null;
  version: number;
  content: string;
} | null> {
  const [row] = await db
    .select({
      id: schema.artifact.id,
      threadId: schema.artifact.threadId,
      title: schema.artifact.title,
      kind: schema.artifact.kind,
      language: schema.artifact.language,
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
      language: schema.artifact.language,
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
 * The artifacts of a conversation the person has edited by hand, with their
 * latest saved content, newest change first (#366). Only these differ from
 * what the model's own earlier tool calls show: it wrote every other version
 * itself, and those calls are in the conversation it is sent.
 */
export async function editedArtifactsForPrompt(threadId: string, userId: string, limit = 10) {
  const latest = and(
    eq(schema.artifactVersion.artifactId, schema.artifact.id),
    eq(schema.artifactVersion.version, schema.artifact.currentVersion),
  );
  return db
    .select({
      id: schema.artifact.id,
      title: schema.artifact.title,
      kind: schema.artifact.kind,
      language: schema.artifact.language,
      currentVersion: schema.artifact.currentVersion,
      content: schema.artifactVersion.content,
    })
    .from(schema.artifact)
    .innerJoin(schema.message, eq(schema.message.id, schema.artifact.messageId))
    .innerJoin(schema.artifactVersion, latest)
    .where(
      and(
        eq(schema.artifact.threadId, threadId),
        eq(schema.artifact.userId, userId),
        isNull(schema.message.supersededAt),
        sql`exists (
          select 1 from ${schema.artifactVersion} as edited
          where edited.artifact_id = ${schema.artifact.id} and edited.source = 'person'
        )`,
      ),
    )
    .orderBy(desc(schema.artifact.updatedAt), desc(schema.artifact.id))
    .limit(limit);
}
