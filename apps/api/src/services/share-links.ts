import { and, asc, count, desc, eq, inArray, isNull, lte, schema, sql } from '@oci/db';
import {
  ERROR_CODES,
  isDeclinedArtifactPart,
  isToolPart,
  MAX_ARTIFACT_TITLE_LENGTH,
  MY_SHARE_LINKS_PAGE_SIZE,
  type MyShareLink,
  type MyShareLinksResponse,
  type PublicArtifact,
  summarizeToolPart,
  type UserRole,
} from '@oci/shared';
import { db } from '../db/index.js';
import { AppError, notFound, validationFailed } from '../lib/errors.js';
import { pathThrough } from './chat/reply-path.js';
import { assertRoleFeature } from './role-features.js';
import { getSetting } from './settings.js';
import { shareableThreadCondition } from './share-link-availability.js';
import { getOwnedThread } from './threads.js';

const PUBLIC_ROLES = ['user', 'assistant'] as const;
const SLUG_BYTES = 24;
const MAX_TEXT_PART_LENGTH = 100_000;
const MAX_SOURCE_URL_LENGTH = 2_048;
const MAX_SOURCE_TITLE_LENGTH = 500;

export interface CreateShareLinkInput {
  upToMessageId?: string | null;
  expiresAt?: Date | null;
}

export type PublicShareUnavailableReason = 'expired' | 'revoked';

/** Sharing needs both the role and the instance to allow it. */
export async function assertShareLinkManagementAllowed(role: UserRole): Promise<void> {
  await assertRoleFeature(role, 'shareLinks');

  const features = await getSetting('features');
  if (!features.shareLinks) {
    throw validationFailed('Public share links are disabled on this instance');
  }
}

async function assertPublicSharingEnabled(): Promise<void> {
  const features = await getSetting('features');
  // Do not disclose whether a valid link exists while sharing is disabled.
  if (!features.shareLinks) throw notFound('Share link not found');
}

function unavailable(reason: PublicShareUnavailableReason): AppError {
  return new AppError(
    ERROR_CODES.NOT_FOUND,
    reason === 'expired' ? 'This share link has expired' : 'This share link has been revoked',
    410,
    { reason },
  );
}

function randomSlug(): string {
  // Web Crypto is provided by the supported Node.js runtime. 192 random bits
  // are encoded without padding, producing a URL-safe 32-character slug.
  const bytes = new Uint8Array(SLUG_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

export async function createShareLink(
  threadId: string,
  userId: string,
  input: CreateShareLinkInput,
) {
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw validationFailed('Expiration must be in the future');
  }

  return db.transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: schema.thread.id })
      .from(schema.thread)
      .where(
        and(
          eq(schema.thread.id, threadId),
          eq(schema.thread.userId, userId),
          shareableThreadCondition(),
        ),
      )
      .limit(1)
      .for('share');
    if (!thread) throw notFound('Thread not found');

    // Hold the thread lock through insertion. A concurrent deletion must either
    // reject creation or see and revoke this new link, never miss it.
    if (input.upToMessageId) {
      const [cutoff] = await tx
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.id, input.upToMessageId),
            eq(schema.message.threadId, threadId),
            inArray(schema.message.role, PUBLIC_ROLES),
          ),
        )
        .limit(1);

      if (!cutoff) throw validationFailed('Snapshot message does not belong to this thread');
    }

    // A unique constraint is the final collision guard.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const [created] = await tx
        .insert(schema.shareLink)
        .values({
          threadId,
          userId,
          slug: randomSlug(),
          upToMessageId: input.upToMessageId ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .onConflictDoNothing({ target: schema.shareLink.slug })
        .returning();

      if (created) return created;
    }

    throw new Error('Failed to generate a unique share-link slug');
  });
}

export async function listShareLinks(threadId: string, userId: string) {
  await getOwnedThread(threadId, userId);

  return db
    .select()
    .from(schema.shareLink)
    .where(and(eq(schema.shareLink.threadId, threadId), eq(schema.shareLink.userId, userId)))
    .orderBy(desc(schema.shareLink.createdAt));
}

/**
 * Every share link one person made, newest first, with the conversation each
 * publishes (Settings → Sharing, v0.10). Only their own links: the owner
 * column is the filter, so another person's id never matches. Revoked and
 * expired links are listed too, until retention removes revoked ones.
 */
export async function listOwnShareLinks(
  userId: string,
  page: { limit?: number; offset?: number } = {},
): Promise<MyShareLinksResponse> {
  const limit = page.limit ?? MY_SHARE_LINKS_PAGE_SIZE;
  const offset = page.offset ?? 0;
  const owned = eq(schema.shareLink.userId, userId);
  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: schema.shareLink.id,
        slug: schema.shareLink.slug,
        threadId: schema.shareLink.threadId,
        threadTitle: schema.thread.title,
        threadAvailable: sql<boolean>`coalesce((${shareableThreadCondition()}), false)`,
        upToMessageId: schema.shareLink.upToMessageId,
        viewCount: schema.shareLink.viewCount,
        expiresAt: schema.shareLink.expiresAt,
        revokedAt: schema.shareLink.revokedAt,
        createdAt: schema.shareLink.createdAt,
      })
      .from(schema.shareLink)
      .innerJoin(schema.thread, eq(schema.thread.id, schema.shareLink.threadId))
      .where(owned)
      .orderBy(desc(schema.shareLink.createdAt), desc(schema.shareLink.id))
      .limit(limit)
      .offset(offset),
    db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${schema.shareLink.revokedAt} is null)::int`,
      })
      .from(schema.shareLink)
      .where(owned),
  ]);
  const total = Number(totals?.total ?? 0);
  const links: MyShareLink[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    path: `/share/${row.slug}`,
    threadId: row.threadId,
    threadTitle: row.threadTitle,
    threadUnavailable: !row.threadAvailable,
    upToMessageId: row.upToMessageId,
    viewCount: row.viewCount,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
  return {
    links,
    total,
    active: Number(totals?.active ?? 0),
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
  };
}

/**
 * Revokes every link the person still has (expired ones too, so none can be
 * brought back by a changed expiry). Returns how many were revoked; links
 * already revoked keep their original time.
 */
export async function revokeAllOwnShareLinks(userId: string): Promise<number> {
  const now = new Date();
  const revoked = await db
    .update(schema.shareLink)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(schema.shareLink.userId, userId), isNull(schema.shareLink.revokedAt)))
    .returning({ id: schema.shareLink.id });
  return revoked.length;
}

/**
 * Revokes one of the person's links. `changed` is false when it was already
 * revoked, so the caller audits only a real revocation. 404 for a link that is
 * not theirs.
 */
export async function revokeOwnShareLink(linkId: string, userId: string) {
  const [revoked] = await db
    .update(schema.shareLink)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.shareLink.id, linkId),
        eq(schema.shareLink.userId, userId),
        isNull(schema.shareLink.revokedAt),
      ),
    )
    .returning();

  if (revoked) return { link: revoked, changed: true };

  const [existing] = await db
    .select()
    .from(schema.shareLink)
    .where(and(eq(schema.shareLink.id, linkId), eq(schema.shareLink.userId, userId)))
    .limit(1);

  if (!existing) throw notFound('Share link not found');
  return { link: existing, changed: false };
}

export async function revokeShareLink(linkId: string, userId: string) {
  return (await revokeOwnShareLink(linkId, userId)).link;
}

/** Redacts common credential forms without exposing hidden message metadata. */
function redactCredentials(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*["']?\s*[:=]\s*["']?)[^\s"'`,;&)\]}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS ACCESS KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, '[REDACTED API KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function sanitizeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_SOURCE_URL_LENGTH) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    url.username = '';
    url.password = '';
    url.hash = '';
    url.pathname = redactCredentials(url.pathname);
    for (const [key, queryValue] of [...url.searchParams.entries()]) {
      if (/(?:key|token|auth|signature|credential|password|secret)/i.test(key)) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, redactCredentials(queryValue));
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

export type PublicMessagePart =
  | { type: 'text'; text: string }
  | { type: 'source-url'; sourceId: string; url: string; title?: string }
  /** A tool step as one summary line; never its inputs' secrets or raw result. */
  | { type: 'tool-step'; toolId: string; summary: string };

/**
 * Strict allowlist for public message parts. Reasoning, system/tool data,
 * attachment metadata and all unknown parts are omitted rather than rewritten
 * into URLs that anonymous viewers cannot access.
 */
export function sanitizePublicParts(parts: unknown): PublicMessagePart[] {
  if (!Array.isArray(parts)) return [];

  return parts.flatMap((part, index): PublicMessagePart[] => {
    if (typeof part !== 'object' || part === null) return [];
    const candidate = part as Record<string, unknown>;

    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      return [
        {
          type: 'text',
          text: redactCredentials(candidate.text.slice(0, MAX_TEXT_PART_LENGTH)),
        },
      ];
    }

    if (isToolPart(candidate)) {
      // Declined as reply content (#201): not a step, and nothing failed.
      if (isDeclinedArtifactPart(candidate)) return [];
      const step = summarizeToolPart(candidate);
      // Steps still running or waiting on the owner's answer say nothing useful publicly.
      if (step.state === 'running' || step.state === 'awaiting-approval') return [];
      return [
        {
          type: 'tool-step',
          toolId: redactCredentials(step.toolId.slice(0, 200)),
          summary: redactCredentials(step.summary.slice(0, MAX_SOURCE_TITLE_LENGTH)),
        },
      ];
    }

    if (candidate.type === 'source-url') {
      const url = sanitizeSourceUrl(candidate.url);
      if (!url) return [];

      const title =
        typeof candidate.title === 'string'
          ? redactCredentials(candidate.title.slice(0, MAX_SOURCE_TITLE_LENGTH))
          : undefined;
      return [
        {
          type: 'source-url',
          sourceId: `source-${index + 1}`,
          url,
          ...(title ? { title } : {}),
        },
      ];
    }

    return [];
  });
}

type Reader = Pick<Parameters<Parameters<typeof db.transaction>[0]>[0], 'select'>;

/**
 * The artifacts a share shows: those created by a shared reply, each at the
 * newest version made by a shared reply or by the owner's own edits (for a
 * snapshot, edits made before the link was created). Versions made by replies
 * outside the share (later turns, replies a retry replaced) are not shown.
 * Content and titles are redacted like message text; every renderer shows
 * HTML and SVG only inside the sandboxed artifact frame.
 */
async function publicArtifacts(
  tx: Reader,
  messageIds: readonly string[],
  snapshotAt: Date | null,
): Promise<PublicArtifact[]> {
  if (messageIds.length === 0) return [];
  const shown = new Set(messageIds);
  const rows = await tx
    .select({
      artifactId: schema.artifact.id,
      messageId: schema.artifact.messageId,
      sourceKey: schema.artifact.sourceKey,
      title: schema.artifact.title,
      kind: schema.artifact.kind,
      language: schema.artifact.language,
      version: schema.artifactVersion.version,
      source: schema.artifactVersion.source,
      versionMessageId: schema.artifactVersion.messageId,
      createdAt: schema.artifactVersion.createdAt,
      content: schema.artifactVersion.content,
    })
    .from(schema.artifact)
    .innerJoin(schema.artifactVersion, eq(schema.artifactVersion.artifactId, schema.artifact.id))
    .where(inArray(schema.artifact.messageId, [...messageIds]))
    .orderBy(
      asc(schema.artifact.createdAt),
      asc(schema.artifact.id),
      desc(schema.artifactVersion.version),
    );
  const chosen = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (chosen.has(row.artifactId)) continue;
    const visible =
      row.source === 'person'
        ? snapshotAt === null || row.createdAt.getTime() <= snapshotAt.getTime()
        : row.versionMessageId !== null && shown.has(row.versionMessageId);
    if (visible) chosen.set(row.artifactId, row);
  }
  return [...chosen.values()].map((row) => ({
    messageId: row.messageId,
    sourceKey: row.sourceKey,
    title: redactCredentials(row.title.slice(0, MAX_ARTIFACT_TITLE_LENGTH)),
    kind: row.kind,
    language: row.language,
    version: row.version,
    content: redactCredentials(row.content),
  }));
}

export async function getPublicShare(slug: string) {
  await assertPublicSharingEnabled();

  return db.transaction(async (tx) => {
    const [link] = await tx
      .select({
        id: schema.shareLink.id,
        threadId: schema.shareLink.threadId,
        title: schema.thread.title,
        upToMessageId: schema.shareLink.upToMessageId,
        expiresAt: schema.shareLink.expiresAt,
        revokedAt: schema.shareLink.revokedAt,
        createdAt: schema.shareLink.createdAt,
      })
      .from(schema.shareLink)
      .innerJoin(schema.thread, eq(schema.thread.id, schema.shareLink.threadId))
      .where(and(eq(schema.shareLink.slug, slug), shareableThreadCondition()))
      .limit(1)
      // Lock only the thread, not the link: the final link update serializes
      // revocation. All lifecycle operations lock thread before share rows.
      .for('share', { of: schema.thread });

    if (!link) throw notFound('Share link not found');
    if (link.revokedAt) throw unavailable('revoked');
    if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) throw unavailable('expired');

    let cutoffPosition: number | null = null;
    if (link.upToMessageId) {
      const [cutoff] = await tx
        .select({ position: schema.message.position })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.id, link.upToMessageId),
            eq(schema.message.threadId, link.threadId),
          ),
        )
        .limit(1);

      if (!cutoff) throw notFound('Shared snapshot is no longer available');
      cutoffPosition = cutoff.position;
    }

    const conditions = [
      eq(schema.message.threadId, link.threadId),
      inArray(schema.message.role, PUBLIC_ROLES),
    ];
    if (cutoffPosition !== null) conditions.push(lte(schema.message.position, cutoffPosition));

    const rows = await tx
      .select({
        id: schema.message.id,
        role: schema.message.role,
        parts: schema.message.parts,
        supersededAt: schema.message.supersededAt,
        createdAt: schema.message.createdAt,
      })
      .from(schema.message)
      .where(and(...conditions))
      .orderBy(asc(schema.message.position));
    // One reply per turn, as the owner reads it. A snapshot ending at a reply
    // that was later switched away from still shows that reply.
    const messages =
      (link.upToMessageId && pathThrough(rows, link.upToMessageId)) ||
      rows.filter((row) => row.supersededAt === null);

    const available = and(
      isNull(schema.shareLink.revokedAt),
      sql`(${schema.shareLink.expiresAt} is null or ${schema.shareLink.expiresAt} > clock_timestamp())`,
      sql`exists (
        select 1 from ${schema.thread}
        where ${schema.thread.id} = ${schema.shareLink.threadId}
          and ${shareableThreadCondition()}
      )`,
    );
    const [view] = await tx
      .update(schema.shareLink)
      .set({ viewCount: sql`${schema.shareLink.viewCount} + 1` })
      .where(and(eq(schema.shareLink.id, link.id), available))
      // WHERE may run before waiting on a row lock. RETURNING checks again
      // after the write; throwing below rolls back the count on elapsed expiry.
      .returning({ available: sql<boolean>`${available}` });

    if (!view?.available) {
      const [latest] = await tx
        .select({ revokedAt: schema.shareLink.revokedAt })
        .from(schema.shareLink)
        .where(eq(schema.shareLink.id, link.id))
        .limit(1);
      throw unavailable(latest?.revokedAt ? 'revoked' : 'expired');
    }

    const artifacts = await publicArtifacts(
      tx,
      messages.filter((message) => message.role === 'assistant').map((message) => message.id),
      link.upToMessageId ? link.createdAt : null,
    );

    return {
      thread: {
        title: redactCredentials(link.title.slice(0, 200)),
        sharedAt: link.createdAt.toISOString(),
      },
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role as (typeof PUBLIC_ROLES)[number],
        parts: sanitizePublicParts(message.parts),
        createdAt: message.createdAt.toISOString(),
      })),
      artifacts,
      snapshot: link.upToMessageId !== null,
      expiresAt: link.expiresAt?.toISOString() ?? null,
    };
  });
}
