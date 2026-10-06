import { and, count, eq, gte, lt, schema, sql } from '@oci/db';
import type { AdminOverview } from '@oci/shared';
import { Hono } from 'hono';
import { db, sql as sqlClient } from '../../db/index.js';
import { onReadReplica } from '../../db/read.js';
import type { AppBindings } from '../../middleware/context.js';
import { chatStreamRedisStatus } from '../../services/chat-streams.js';
import { activityWindowStart, fillActivityDays } from '../../services/overview-activity.js';
import { APP_VERSION } from '../../version.js';

export const overviewRoutes = new Hono<AppBindings>();

overviewRoutes.get('/', async (c) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    userTotals,
    activeUsers,
    adminUsers,
    threadTotals,
    recentThreads,
    messageTotals,
    recentMessages,
    modelTotals,
    enabledModels,
    providerTotals,
    enabledProviders,
    previousThreads,
    previousMessages,
    activityRows,
    storageTotals,
  ] =
    // Instance-wide counts: may come from the read replica (db/read.ts).
    await onReadReplica(() =>
      Promise.all([
        db.select({ value: count() }).from(schema.user),
        db
          .select({ value: count() })
          .from(schema.user)
          .where(gte(schema.user.lastSeenAt, monthAgo)),
        db.select({ value: count() }).from(schema.user).where(eq(schema.user.role, 'admin')),
        db.select({ value: count() }).from(schema.thread),
        db
          .select({ value: count() })
          .from(schema.thread)
          .where(gte(schema.thread.createdAt, dayAgo)),
        db.select({ value: count() }).from(schema.message),
        db
          .select({ value: count() })
          .from(schema.message)
          .where(gte(schema.message.createdAt, dayAgo)),
        db.select({ value: count() }).from(schema.model),
        db.select({ value: count() }).from(schema.model).where(eq(schema.model.enabled, true)),
        db.select({ value: count() }).from(schema.provider),
        db
          .select({ value: count() })
          .from(schema.provider)
          .where(eq(schema.provider.enabled, true)),
        db
          .select({ value: count() })
          .from(schema.thread)
          .where(
            and(gte(schema.thread.createdAt, twoDaysAgo), lt(schema.thread.createdAt, dayAgo)),
          ),
        db
          .select({ value: count() })
          .from(schema.message)
          .where(
            and(gte(schema.message.createdAt, twoDaysAgo), lt(schema.message.createdAt, dayAgo)),
          ),
        // Grouped in the database rather than fetched and bucketed here: the row
        // count is fourteen either way, but the message table is not. Days are
        // UTC whatever the database session's zone, and only the days with
        // messages come back: fillActivityDays adds the quiet ones (#348).
        db
          .select({
            day: sql<string>`to_char(date_trunc('day', ${schema.message.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
            messages: count(),
          })
          .from(schema.message)
          .where(gte(schema.message.createdAt, activityWindowStart(new Date())))
          .groupBy(sql`date_trunc('day', ${schema.message.createdAt} at time zone 'UTC')`)
          .orderBy(sql`date_trunc('day', ${schema.message.createdAt} at time zone 'UTC')`),
        db
          .select({
            files: sql<number>`count(*) filter (where ${schema.attachment.deletedAt} is null)::int`,
            bytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}) filter (where ${schema.attachment.deletedAt} is null), 0)`,
            // Soft-deleted files still occupy disk, so an operator planning
            // capacity needs to see them even though users no longer do.
            pendingFiles: sql<number>`count(*) filter (where ${schema.attachment.deletedAt} is not null)::int`,
            pendingBytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}) filter (where ${schema.attachment.deletedAt} is not null), 0)`,
          })
          .from(schema.attachment),
      ]),
    );

  let database: 'ok' | 'error' = 'ok';
  try {
    await sqlClient`select 1`;
  } catch {
    database = 'error';
  }

  const payload: AdminOverview = {
    users: {
      total: userTotals[0]?.value ?? 0,
      active30d: activeUsers[0]?.value ?? 0,
      admins: adminUsers[0]?.value ?? 0,
    },
    threads: {
      total: threadTotals[0]?.value ?? 0,
      last24h: recentThreads[0]?.value ?? 0,
      previous24h: previousThreads[0]?.value ?? 0,
    },
    messages: {
      total: messageTotals[0]?.value ?? 0,
      last24h: recentMessages[0]?.value ?? 0,
      previous24h: previousMessages[0]?.value ?? 0,
    },
    activity: fillActivityDays(activityRows, new Date()),
    models: { enabled: enabledModels[0]?.value ?? 0, total: modelTotals[0]?.value ?? 0 },
    providers: {
      configured: providerTotals[0]?.value ?? 0,
      enabled: enabledProviders[0]?.value ?? 0,
    },
    storage: {
      fileCount: Number(storageTotals[0]?.files ?? 0),
      totalBytes: Number(storageTotals[0]?.bytes ?? 0),
      pendingFileCount: Number(storageTotals[0]?.pendingFiles ?? 0),
      pendingBytes: Number(storageTotals[0]?.pendingBytes ?? 0),
    },
    system: { version: APP_VERSION, database, redis: await chatStreamRedisStatus() },
  };

  return c.json(payload);
});
