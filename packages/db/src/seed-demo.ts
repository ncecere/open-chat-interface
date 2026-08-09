import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import * as schema from './schema/index.js';

/**
 * A plausible instance, for documentation screenshots.
 *
 * Separate from `seed.ts`, which establishes the defaults a real deployment
 * needs. This one invents people and conversations, so it must never run
 * against an instance anybody uses.
 *
 * Timestamps are derived from a pinned instant rather than `now()`. Screenshots
 * are committed, and a dataset that drifts every run would rewrite every image
 * with no change worth reviewing.
 */
const DEMO_NOW = new Date('2026-06-15T14:30:00.000Z');

const ORGANIZATION_NAME = 'Northbrook University';

function daysBefore(days: number, hours = 0): Date {
  return new Date(DEMO_NOW.getTime() - days * 86_400_000 - hours * 3_600_000);
}

/** Deterministic identifiers, so re-seeding produces the same rows. */
function demoId(kind: string, index: number): string {
  return `demo-${kind}-${String(index).padStart(3, '0')}`;
}

const PEOPLE = [
  { name: 'Amara Okafor', email: 'a.okafor@northbrook.edu', role: 'admin', dept: 'IT Services' },
  { name: 'Dev Raman', email: 'd.raman@northbrook.edu', role: 'admin', dept: 'IT Services' },
  {
    name: 'Sofia Lindqvist',
    email: 's.lindqvist@northbrook.edu',
    role: 'auditor',
    dept: 'Compliance',
  },
  { name: 'Marcus Bell', email: 'm.bell@northbrook.edu', role: 'user', dept: 'Research Computing' },
  { name: 'Priya Nair', email: 'p.nair@northbrook.edu', role: 'user', dept: 'Library' },
  { name: 'Tomás Herrera', email: 't.herrera@northbrook.edu', role: 'user', dept: 'Physics' },
  {
    name: 'Grace Whitfield',
    email: 'g.whitfield@northbrook.edu',
    role: 'user',
    dept: 'Admissions',
  },
  { name: 'Jonas Weber', email: 'j.weber@northbrook.edu', role: 'user', dept: 'Chemistry' },
  { name: 'Leila Haddad', email: 'l.haddad@northbrook.edu', role: 'user', dept: 'Registrar' },
  { name: 'Owen Fitzgerald', email: 'o.fitzgerald@northbrook.edu', role: 'user', dept: 'Estates' },
  { name: 'Hana Sato', email: 'h.sato@northbrook.edu', role: 'user', dept: 'Mathematics' },
  {
    name: 'Ruth Mensah',
    email: 'r.mensah@northbrook.edu',
    role: 'restricted',
    dept: 'Contractors',
  },
  {
    name: 'Callum Doyle',
    email: 'c.doyle@northbrook.edu',
    role: 'restricted',
    dept: 'Contractors',
  },
];

/** Conversations a university would plausibly hold, and nothing sensitive. */
const CONVERSATIONS = [
  { title: 'Summarise the new research data policy', person: 3, days: 0 },
  { title: 'Draft an email about library opening hours', person: 4, days: 0 },
  { title: 'Explain eigenvalues for a first-year lecture', person: 10, days: 0 },
  { title: 'Compare two approaches to lab scheduling', person: 5, days: 1 },
  { title: 'Rewrite this admissions FAQ more plainly', person: 6, days: 1 },
  { title: 'What changed in the 2026 funding guidance?', person: 3, days: 2 },
  { title: 'Help me structure a grant methodology section', person: 7, days: 2 },
  { title: 'Turn these notes into a reading list', person: 4, days: 3 },
  { title: 'Check this SQL query for correctness', person: 3, days: 4 },
  { title: 'Plan a migration for the timetable system', person: 9, days: 5 },
  { title: 'Explain the difference between these two statutes', person: 8, days: 6 },
  { title: 'Draft a maintenance notice for the halls', person: 9, days: 8 },
];

export async function seedDemoData(db: Database): Promise<void> {
  const [org] = await db.select().from(schema.organization).limit(1);
  if (!org) throw new Error('Seed the base data first: pnpm db:seed');

  await db
    .update(schema.organization)
    .set({ name: ORGANIZATION_NAME })
    .where(eq(schema.organization.id, org.id));

  // Removed first so re-running produces the same instance rather than
  // accumulating a second cohort of demonstration people.
  await clearDemoData(db);

  const userIds: string[] = [];
  for (const [index, person] of PEOPLE.entries()) {
    const id = demoId('user', index);
    userIds.push(id);

    await db.insert(schema.user).values({
      id,
      name: person.name,
      email: person.email,
      emailVerified: true,
      role: person.role as 'admin' | 'auditor' | 'user' | 'restricted',
      organizationId: org.id,
      createdAt: daysBefore(200 - index * 12),
      updatedAt: daysBefore(index),
      // Spread so the "active in the last 30 days" figure is neither
      // everybody nor nobody.
      lastSeenAt: index < 9 ? daysBefore(index % 6, index) : daysBefore(45 + index),
    });
  }

  const [model] = await db.select().from(schema.model).limit(1);
  const modelSlug = model?.slug ?? 'demo-model';

  for (const [index, conversation] of CONVERSATIONS.entries()) {
    const threadId = demoId('thread', index);
    const ownerId = userIds[conversation.person] ?? userIds[0];
    if (!ownerId) continue;

    const updatedAt = daysBefore(conversation.days, index);

    await db.insert(schema.thread).values({
      id: threadId,
      userId: ownerId,
      organizationId: org.id,
      title: conversation.title,
      createdAt: updatedAt,
      updatedAt,
      pinned: index < 2,
    });

    // Two messages each: enough for a thread to look real in a list, without
    // inventing model output that would misrepresent what a model says.
    await db.insert(schema.message).values([
      {
        id: `${threadId}-m1`,
        threadId,
        userId: ownerId,
        role: 'user',
        // The AI SDK message shape, which is what the interface renders.
        parts: [{ type: 'text', text: conversation.title }],
        position: 1,
        createdAt: updatedAt,
      },
      {
        id: `${threadId}-m2`,
        threadId,
        userId: ownerId,
        role: 'assistant',
        parts: [{ type: 'text', text: 'A worked answer would appear here.' }],
        position: 2,
        modelSlug,
        createdAt: new Date(updatedAt.getTime() + 20_000),
      },
    ]);
  }

  await seedAdminConversations(db, modelSlug);
  await seedUsageHistory(db, org.id, userIds, modelSlug);
  await seedAuditHistory(db, org.id, userIds);
}

/**
 * Conversations belonging to the signed-in administrator.
 *
 * The seeded people own the rest, and screenshots are taken as the
 * administrator — who would otherwise see an empty sidebar, which is the one
 * thing the chat documentation cannot illustrate with.
 */
async function seedAdminConversations(db: Database, modelSlug: string): Promise<void> {
  const [admin] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.role, 'admin'))
    .limit(1);

  if (!admin) return;

  const titles = [
    'Explain how retention policies work',
    'Draft release notes for the June update',
    'Summarise the support tickets from this week',
    'What does this error message mean?',
    'Compare two options for backup scheduling',
    'Write a short announcement about maintenance',
  ];

  for (const [index, title] of titles.entries()) {
    const threadId = demoId('thread-admin', index);
    const updatedAt = daysBefore(index, index * 2);

    await db.insert(schema.thread).values({
      id: threadId,
      userId: admin.id,
      organizationId: (await db.select().from(schema.organization).limit(1))[0]?.id ?? '',
      title,
      createdAt: updatedAt,
      updatedAt,
      pinned: index === 0,
    });

    await db.insert(schema.message).values([
      {
        id: `${threadId}-m1`,
        threadId,
        userId: admin.id,
        role: 'user',
        parts: [{ type: 'text', text: title }],
        position: 1,
        createdAt: updatedAt,
      },
      {
        id: `${threadId}-m2`,
        threadId,
        userId: admin.id,
        role: 'assistant',
        parts: [{ type: 'text', text: 'A worked answer would appear here.' }],
        position: 2,
        modelSlug,
        createdAt: new Date(updatedAt.getTime() + 20_000),
      },
    ]);
  }
}

/**
 * Thirty days of usage, weighted so the charts show a shape.
 *
 * Flat data would render as a straight line and prove nothing about whether
 * the chart works.
 */
async function seedUsageHistory(
  db: Database,
  organizationId: string,
  userIds: string[],
  modelSlug: string,
): Promise<void> {
  for (let day = 29; day >= 0; day -= 1) {
    const date = daysBefore(day);
    const weekday = date.getUTCDay();
    // Quieter at weekends, which is what a university actually looks like.
    const base = weekday === 0 || weekday === 6 ? 3 : 12;
    const volume = base + ((day * 7) % 9);

    for (let n = 0; n < volume; n += 1) {
      const userId = userIds[n % userIds.length];
      if (!userId) continue;

      await db.insert(schema.usageEvent).values({
        id: randomUUID(),
        organizationId,
        userId,
        modelSlug,
        messageCount: 1,
        tokensIn: 400 + ((n * 37) % 900),
        tokensOut: 200 + ((n * 53) % 700),
        costMicros: 1_200 + ((n * 91) % 4_000),
        occurredAt: new Date(date.getTime() + n * 900_000),
      });
    }
  }
}

async function seedAuditHistory(
  db: Database,
  organizationId: string,
  userIds: string[],
): Promise<void> {
  const events = [
    { action: 'auth.signin.local.success', actor: 0, days: 0 },
    { action: 'settings.update', actor: 0, days: 0 },
    { action: 'model.update', actor: 1, days: 1 },
    { action: 'user.bulk.set_role', actor: 0, days: 1 },
    { action: 'auth.signin.local.failure', actor: 4, days: 2 },
    { action: 'quota.policy.update', actor: 1, days: 3 },
    { action: 'broadcast.create', actor: 0, days: 4 },
    { action: 'sso.update', actor: 1, days: 6 },
    { action: 'policy.publish', actor: 0, days: 9 },
    { action: 'provider.create', actor: 1, days: 14 },
  ];

  for (const [index, event] of events.entries()) {
    const actorId = userIds[event.actor];
    const person = PEOPLE[event.actor];
    if (!actorId || !person) continue;

    await db.insert(schema.auditLog).values({
      id: demoId('audit', index),
      organizationId,
      actorUserId: actorId,
      actorEmail: person.email,
      action: event.action,
      targetType: 'instance',
      ipAddress: `10.24.${index}.${40 + index}`,
      createdAt: daysBefore(event.days, index),
    });
  }
}

/** Removes only demonstration rows, matched by their deterministic prefix. */
export async function clearDemoData(db: Database): Promise<void> {
  await db.execute(sql`delete from message where id like 'demo-thread%'`);
  await db.execute(sql`delete from thread where id like 'demo-thread%'`);
  await db.execute(sql`delete from audit_log where id like 'demo-audit-%'`);
  await db.execute(sql`delete from usage_event where user_id like 'demo-user-%'`);
  await db.execute(sql`delete from session where user_id like 'demo-user-%'`);
  await db.execute(sql`delete from account where user_id like 'demo-user-%'`);
  await db.execute(sql`delete from "user" where id like 'demo-user-%'`);
}

/** CLI entry point for `pnpm db:seed:demo`. */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to seed');

  const { createDatabase } = await import('./client.js');
  const { db, sql } = createDatabase(connectionString, { max: 1 });

  if (process.argv.includes('--clear')) {
    await clearDemoData(db);
    console.log('Demonstration data removed.');
  } else {
    await seedDemoData(db);
    console.log('Demonstration data seeded.');
  }

  await sql.end();
}

// Matched on the exact filename: `seed.ts` guards on a substring, which this
// module's name would otherwise satisfy when it is merely imported.
if (process.argv[1]?.endsWith('seed-demo.ts') || process.argv[1]?.endsWith('seed-demo.js')) {
  main().catch((error) => {
    console.error('Demo seed failed:', error);
    process.exit(1);
  });
}
