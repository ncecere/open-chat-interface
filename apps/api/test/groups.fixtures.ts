import { randomUUID } from 'node:crypto';
import { type Database, schema, sql } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { Hono } from 'hono';
import { expect } from 'vitest';
import {
  type AppBindings,
  type AuthenticatedUser,
  requireAdmin,
} from '../src/middleware/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { groupAdminRoutes, userGroupRoutes } from '../src/routes/admin/groups.js';
import { groupRoutes } from '../src/routes/groups.js';

/**
 * Shared fixtures for the live groups suites (groups-*.live.test.ts): the app
 * under test (the admin and the signed-in group routes, mounted as the real
 * router mounts them), people, and request helpers. Each suite declares its own
 * `vi.mock` block and `state`; the routes imported here are the mocked ones.
 */
export type Actor = AuthenticatedUser;

export function appFor(actor: Actor | null) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', actor);
    await next();
  });
  app.use('/admin/*', requireAdmin);
  app.route('/admin/groups', groupAdminRoutes);
  app.route('/admin/users', userGroupRoutes);
  app.route('/groups', groupRoutes);
  return app;
}

export async function call(actor: Actor | null, method: string, path: string, body?: unknown) {
  return appFor(actor).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as T;
}

/** The error a refusal carried. */
export async function refusal(response: Response, status: number) {
  const body = await json<{ error: { code: string; message: string; details?: unknown } }>(
    response,
    status,
  );
  return body.error;
}

let counter = 0;

/** A person with a chosen role, name and address; the actor to call routes as. */
export async function person(
  db: Database,
  organizationId: string,
  options: { role?: UserRole; name?: string; email?: string } = {},
): Promise<Actor> {
  counter += 1;
  const id = randomUUID();
  const role = options.role ?? 'user';
  const name = options.name ?? `Person ${counter}`;
  const email = options.email ?? `person-${counter}-${id.slice(0, 6)}@example.test`;
  await db.execute(
    sql`insert into "user" (id, name, email, email_verified, role, organization_id)
        values (${id}, ${name}, ${email}, true, ${role}, ${organizationId})`,
  );
  return { id, name, email, image: null, role, emailVerified: true, organizationId };
}

export async function groupNamed(db: Database, organizationId: string, name: string) {
  const [row] = await db.insert(schema.group).values({ organizationId, name }).returning();
  return row!;
}

export async function addMember(
  db: Database,
  groupId: string,
  userId: string,
  role: 'member' | 'manager' = 'member',
) {
  await db.insert(schema.groupMember).values({ groupId, userId, role });
}
