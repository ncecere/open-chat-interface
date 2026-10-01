import { createDatabase, eq, schema } from '@oci/db';
import { createLiveDatabase, seedOrganization, seedUser } from './live-postgres.js';

/** Real migrations and a multi-connection pool, isolated from every other suite. */
export async function createShareLifecycleFixture(label: string) {
  const live = await createLiveDatabase(label);
  const { db, sql: client } = createDatabase(live.connectionString, { max: 6 });
  const organizationId = await seedOrganization(db);
  const userId = await seedUser(db, organizationId);

  async function thread(patch: Partial<typeof schema.thread.$inferInsert> = {}) {
    const [row] = await db
      .insert(schema.thread)
      .values({
        organizationId,
        userId,
        title: 'Private conversation',
        ...patch,
      })
      .returning();
    if (!row) throw new Error('Failed to create thread fixture');
    await db.insert(schema.message).values({
      threadId: row.id,
      userId,
      role: 'user',
      position: 0,
      parts: [{ type: 'text', text: 'Private fixture content' }],
    });
    return row;
  }

  async function reset() {
    await db.delete(schema.thread);
    await db.delete(schema.storageUsage);
  }

  async function linkState(id: string) {
    const [row] = await db.select().from(schema.shareLink).where(eq(schema.shareLink.id, id));
    if (!row) throw new Error('Missing share fixture');
    return row;
  }

  return {
    db,
    client,
    live,
    organizationId,
    userId,
    thread,
    reset,
    linkState,
    async destroy() {
      await client.end({ timeout: 5 });
      await live.destroy();
    },
  };
}

export type ShareLifecycleFixture = Awaited<ReturnType<typeof createShareLifecycleFixture>>;
