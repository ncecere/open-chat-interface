import { and, asc, desc, eq, inArray, isNull, lte, schema, sql } from '@oci/db';
import { ERROR_CODES, type UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { AppError, forbidden, notFound, validationFailed } from '../lib/errors.js';
import { getSetting } from './settings.js';
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

/** Sharing is intentionally unavailable to restricted users, even when enabled instance-wide. */
export async function assertShareLinkManagementAllowed(role: UserRole): Promise<void> {
  if (role === 'restricted') {
    throw forbidden('Your role does not allow public share links');
  }

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
  await getOwnedThread(threadId, userId);

  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw validationFailed('Expiration must be in the future');
  }

  if (input.upToMessageId) {
    const [cutoff] = await db
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

  // A unique constraint is the final collision guard. Retrying keeps creation
  // deterministic even in the extraordinarily unlikely event of a collision.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const [created] = await db
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
}

export async function listShareLinks(threadId: string, userId: string) {
  await getOwnedThread(threadId, userId);

  return db
    .select()
    .from(schema.shareLink)
    .where(and(eq(schema.shareLink.threadId, threadId), eq(schema.shareLink.userId, userId)))
    .orderBy(desc(schema.shareLink.createdAt));
}

export async function revokeShareLink(linkId: string, userId: string) {
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

  if (revoked) return revoked;

  const [existing] = await db
    .select()
    .from(schema.shareLink)
    .where(and(eq(schema.shareLink.id, linkId), eq(schema.shareLink.userId, userId)))
    .limit(1);

  if (!existing) throw notFound('Share link not found');
  return existing;
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
  | { type: 'source-url'; sourceId: string; url: string; title?: string };

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
      .where(eq(schema.shareLink.slug, slug))
      .limit(1);

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

    const messages = await tx
      .select({
        id: schema.message.id,
        role: schema.message.role,
        parts: schema.message.parts,
        createdAt: schema.message.createdAt,
      })
      .from(schema.message)
      .where(and(...conditions))
      .orderBy(asc(schema.message.position));

    // Recheck availability in the write itself so a concurrent revoke/expiry
    // cannot produce a successful response or an inflated count.
    const [view] = await tx
      .update(schema.shareLink)
      .set({ viewCount: sql`${schema.shareLink.viewCount} + 1` })
      .where(
        and(
          eq(schema.shareLink.id, link.id),
          isNull(schema.shareLink.revokedAt),
          sql`(${schema.shareLink.expiresAt} is null or ${schema.shareLink.expiresAt} > now())`,
        ),
      )
      .returning({ viewCount: schema.shareLink.viewCount });

    if (!view) {
      const [latest] = await tx
        .select({ revokedAt: schema.shareLink.revokedAt })
        .from(schema.shareLink)
        .where(eq(schema.shareLink.id, link.id))
        .limit(1);
      throw unavailable(latest?.revokedAt ? 'revoked' : 'expired');
    }

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
      snapshot: link.upToMessageId !== null,
      expiresAt: link.expiresAt?.toISOString() ?? null,
    };
  });
}
