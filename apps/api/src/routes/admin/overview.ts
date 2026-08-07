import { count, eq, gte, schema, sql } from '@oci/db';
import type { AdminOverview } from '@oci/shared';
import { Hono } from 'hono';
import { db, sql as sqlClient } from '../../db/index.js';
import type { AppBindings } from '../../middleware/context.js';
import { chatStreamRedisStatus } from '../../services/chat-streams.js';

export const overviewRoutes = new Hono<AppBindings>();

const APP_VERSION = '0.1.0';

overviewRoutes.get('/', async (c) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
    storageTotals,
  ] = await Promise.all([
    db.select({ value: count() }).from(schema.user),
    db.select({ value: count() }).from(schema.user).where(gte(schema.user.lastSeenAt, monthAgo)),
    db.select({ value: count() }).from(schema.user).where(eq(schema.user.role, 'admin')),
    db.select({ value: count() }).from(schema.thread),
    db.select({ value: count() }).from(schema.thread).where(gte(schema.thread.createdAt, dayAgo)),
    db.select({ value: count() }).from(schema.message),
    db.select({ value: count() }).from(schema.message).where(gte(schema.message.createdAt, dayAgo)),
    db.select({ value: count() }).from(schema.model),
    db.select({ value: count() }).from(schema.model).where(eq(schema.model.enabled, true)),
    db.select({ value: count() }).from(schema.provider),
    db.select({ value: count() }).from(schema.provider).where(eq(schema.provider.enabled, true)),
    db
      .select({
        files: count(),
        bytes: sql<number>`coalesce(sum(${schema.attachment.sizeBytes}), 0)`,
      })
      .from(schema.attachment),
  ]);

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
    threads: { total: threadTotals[0]?.value ?? 0, last24h: recentThreads[0]?.value ?? 0 },
    messages: { total: messageTotals[0]?.value ?? 0, last24h: recentMessages[0]?.value ?? 0 },
    models: { enabled: enabledModels[0]?.value ?? 0, total: modelTotals[0]?.value ?? 0 },
    providers: {
      configured: providerTotals[0]?.value ?? 0,
      enabled: enabledProviders[0]?.value ?? 0,
    },
    storage: {
      fileCount: storageTotals[0]?.files ?? 0,
      totalBytes: Number(storageTotals[0]?.bytes ?? 0),
    },
    system: { version: APP_VERSION, database, redis: await chatStreamRedisStatus() },
  };

  return c.json(payload);
});
