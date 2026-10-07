import { randomUUID } from 'node:crypto';
import { and, type Database, eq, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { hashPassword } from 'better-auth/crypto';
import { Hono } from 'hono';
import { expect } from 'vitest';
import {
  type AppBindings,
  type AuthenticatedUser,
  requireAdmin,
} from '../src/middleware/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { rolesRoutes } from '../src/routes/admin/roles.js';
import { meRoutes } from '../src/routes/me.js';
import { shareLinkRoutes } from '../src/routes/share-links.js';
import { seedUser } from './live-postgres.js';

/**
 * Shared fixtures for the live v0.10 settings-for-people suites
 * (personal-settings-*.live.test.ts): the app under test, request helpers and
 * people with a password or an organisation sign-in. Each suite declares its
 * own `vi.mock` block and `state`; the routes imported here are the mocked ones.
 */
export const PASSWORD = 'Personal-settings-123!';

export function appFor(actor: AuthenticatedUser, sessionId: string | null = null) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', actor);
    c.set('sessionId', sessionId);
    await next();
  });
  app.use('/admin/*', requireAdmin);
  app.route('/admin/roles', rolesRoutes);
  app.route('/me', meRoutes);
  app.route('/share-links', shareLinkRoutes);
  return app;
}

export async function call(actor: AuthenticatedUser, method: string, path: string, body?: unknown) {
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

export async function errorOf(response: Response, status: number): Promise<string> {
  const body = await json<{ error: { message: string } }>(response, status);
  return body.error.message;
}

/** Helpers over the live database; `db` is read when each is called. */
export function personalSettingsHelpers(state: { organizationId: string }, db: () => Database) {
  async function person(
    role: UserRole = 'user',
    { password = true }: { password?: boolean } = {},
  ): Promise<AuthenticatedUser> {
    const email = `${randomUUID().slice(0, 8)}@people.test`;
    const id = await seedUser(db(), state.organizationId, { role, email });
    if (password) {
      await db()
        .insert(schema.account)
        .values({
          id: randomUUID(),
          accountId: id,
          providerId: 'credential',
          userId: id,
          password: await hashPassword(PASSWORD),
        });
    } else {
      await db()
        .insert(schema.account)
        .values({
          id: randomUUID(),
          accountId: `sso-${id}`,
          providerId: 'campus-sso',
          userId: id,
        });
    }
    return {
      id,
      role,
      email,
      name: 'Test User',
      image: null,
      emailVerified: true,
      organizationId: state.organizationId,
    };
  }

  async function auditEntries(action: string, actorUserId?: string) {
    return db()
      .select()
      .from(schema.auditLog)
      .where(
        actorUserId
          ? and(eq(schema.auditLog.action, action), eq(schema.auditLog.actorUserId, actorUserId))
          : eq(schema.auditLog.action, action),
      );
  }

  async function exists(id: string) {
    const rows = await db()
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, id));
    return rows.length === 1;
  }

  return { person, auditEntries, exists };
}
