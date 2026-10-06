import { and, count, desc, eq, gte, ilike, lte, or, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { containsPattern, prefixPattern } from '../../lib/like.js';
import type { AppBindings } from '../../middleware/context.js';
import { parseQuery } from '../../middleware/validate.js';
import {
  actorAccountEmail,
  auditEntryAbout,
  auditEntryAboutEmail,
} from '../../services/audit-subject.js';

export const auditRoutes = new Hono<AppBindings>();

/**
 * Filtering happens in the query rather than in the browser.
 *
 * The previous listing returned the two hundred most recent rows and filtered
 * those, so a search described only what had already been fetched and the rest
 * of the history was unreachable — which is the opposite of what an
 * investigation needs.
 */
const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  /**
   * Every event by or about one account: it acted, it was the target, or a
   * bulk action named it (services/audit-subject.ts). The
   * same rule as the Recent activity panel on the account's page, which links
   * here with it.
   */
  userId: z.string().trim().min(1).max(200).optional(),
  action: z.string().trim().max(120).optional(),
  actorEmail: z.string().trim().max(320).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type AuditFilters = z.infer<typeof listQuerySchema>;

function buildWhere(filters: Omit<AuditFilters, 'limit' | 'offset'>) {
  const clauses = [
    filters.search
      ? or(
          ilike(schema.auditLog.actorEmail, containsPattern(filters.search)),
          ilike(schema.auditLog.action, containsPattern(filters.search)),
          ilike(schema.auditLog.targetId, containsPattern(filters.search)),
          ilike(schema.auditLog.ipAddress, containsPattern(filters.search)),
          // Metadata holds what the other columns do not: the email of a
          // deleted account, a role change's from and to, a provider's name.
          ilike(sql`${schema.auditLog.metadata}::text`, containsPattern(filters.search)),
          // Things done to an account found by its email: those entries carry
          // its id, not its email (#216).
          auditEntryAboutEmail(containsPattern(filters.search)),
        )
      : undefined,
    // Including the bulk actions that named the account (#216).
    filters.userId ? auditEntryAbout(filters.userId) : undefined,
    // Matches a family as well as an exact action, so "auth." finds every
    // authentication event without naming each one.
    filters.action ? ilike(schema.auditLog.action, prefixPattern(filters.action)) : undefined,
    filters.actorEmail ? eq(schema.auditLog.actorEmail, filters.actorEmail) : undefined,
    filters.from ? gte(schema.auditLog.createdAt, new Date(filters.from)) : undefined,
    filters.to ? lte(schema.auditLog.createdAt, new Date(filters.to)) : undefined,
  ].filter((clause) => clause !== undefined);

  return clauses.length > 0 ? and(...clauses) : undefined;
}

auditRoutes.get('/', async (c) => {
  const filters = parseQuery(c, listQuerySchema);
  const where = buildWhere(filters);

  const [rows, [totals]] = await Promise.all([
    db
      .select({ entry: schema.auditLog, accountEmail: actorAccountEmail })
      .from(schema.auditLog)
      .where(where)
      // A stable tiebreak keeps pagination from repeating a row when several
      // events share a timestamp, which bulk actions produce readily.
      .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
      .limit(filters.limit)
      .offset(filters.offset),
    db.select({ value: count() }).from(schema.auditLog).where(where),
  ]);

  return c.json({
    entries: rows.map(({ entry, accountEmail }) => ({
      ...entry,
      // Entries recorded with only an ID name the account (#280).
      actorEmail: entry.actorEmail ?? accountEmail,
      createdAt: entry.createdAt.toISOString(),
    })),
    total: totals?.value ?? 0,
  });
});

/** Distinct actions present in the log, so the filter offers what exists. */
auditRoutes.get('/actions', async (c) => {
  const rows = await db
    .selectDistinct({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .orderBy(schema.auditLog.action);

  return c.json({ actions: rows.map((row) => row.action) });
});

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // Escaped rather than stripped: a comma or newline inside a value must not
  // be able to shift the remaining columns.
  return `"${text.replaceAll('"', '""')}"`;
}

const EXPORT_LIMIT = 50_000;

auditRoutes.get('/export', async (c) => {
  const filters = parseQuery(c, listQuerySchema);
  const where = buildWhere(filters);

  const rows = await db
    .select({ entry: schema.auditLog, accountEmail: actorAccountEmail })
    .from(schema.auditLog)
    .where(where)
    .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
    // Bounded so a request cannot try to hold an unbounded history in memory.
    // A larger extract is a database job, not a download.
    .limit(EXPORT_LIMIT);

  const header =
    'timestamp,actor_email,actor_user_id,action,target_type,target_id,ip_address,metadata';
  const body = rows
    .map(({ entry: row, accountEmail }) =>
      [
        row.createdAt.toISOString(),
        row.actorEmail ?? accountEmail,
        row.actorUserId,
        row.action,
        row.targetType,
        row.targetId,
        row.ipAddress,
        row.metadata,
      ]
        .map(csvCell)
        .join(','),
    )
    .join('\n');

  const stamp = new Date().toISOString().slice(0, 10);
  return c.body(`${header}\n${body}\n`, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="audit-log-${stamp}.csv"`,
  });
});

/** Counts by action over a window, for spotting a spike without reading rows. */
auditRoutes.get('/summary', async (c) => {
  const filters = parseQuery(c, listQuerySchema);
  const where = buildWhere(filters);

  const rows = await db
    .select({
      action: schema.auditLog.action,
      total: count(),
      lastSeen: sql<string>`max(${schema.auditLog.createdAt})`,
    })
    .from(schema.auditLog)
    .where(where)
    .groupBy(schema.auditLog.action)
    .orderBy(desc(count()))
    .limit(50);

  return c.json({ summary: rows });
});
