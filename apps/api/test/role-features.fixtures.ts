import { type Database, schema } from '@oci/db';
import type { RoleFeatureKey, SendMessageInput, UserRole } from '@oci/shared';
import { Hono } from 'hono';
import { expect } from 'vitest';
import {
  type AppBindings,
  type AuthenticatedUser,
  requireAdmin,
} from '../src/middleware/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { rolesRoutes } from '../src/routes/admin/roles.js';
import { settingsRoutes } from '../src/routes/admin/settings.js';
import { meRoutes } from '../src/routes/me.js';
import { modelCatalogRoutes } from '../src/routes/models.js';
import { threadRoutes } from '../src/routes/threads.js';
import { assertArtifactsAllowed } from '../src/services/artifacts/store.js';
import { assertAttachmentUseAllowed } from '../src/services/attachments/index.js';
import { resolveTurnContext } from '../src/services/chat/turn-context.js';
import { assertMemoryAvailable } from '../src/services/memory/store.js';
import { assertProjectsAllowed } from '../src/services/projects.js';
import { assertRoleFeature } from '../src/services/role-features.js';
import { assertShareLinkManagementAllowed } from '../src/services/share-links.js';
import { assertTemporaryChatAllowed, createThread } from '../src/services/threads.js';
import { seedUser } from './live-postgres.js';

/**
 * Shared fixtures for the live feature-entitlement suites
 * (role-features-*.live.test.ts): the app under test, request helpers, one
 * person per role, the models, and helpers that report how each feature check
 * ends for a role. Each suite declares its own `vi.mock` block and `state`;
 * the routes and services imported here are the mocked ones.
 */
export type Actor = AuthenticatedUser;

export const ALL_ON = {
  shareLinks: true,
  temporaryChat: true,
  webSearch: true,
  attachments: true,
  branching: true,
  memory: true,
};

export function appFor(actor: Actor) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('user', actor);
    await next();
  });
  app.use('/admin/*', requireAdmin);
  app.route('/admin/roles', rolesRoutes);
  app.route('/admin/settings', settingsRoutes);
  app.route('/me', meRoutes);
  app.route('/models', modelCatalogRoutes);
  app.route('/threads', threadRoutes);
  return app;
}

export async function call(actor: Actor, method: string, path: string, body?: unknown) {
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

/** Runs one check and reports how it ended, so cases compare compactly. */
export async function outcome(check: () => Promise<unknown>): Promise<'allowed' | number> {
  try {
    await check();
    return 'allowed';
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (typeof status !== 'number') throw error;
    return status;
  }
}

/** Seeds one person per role into `actors`, and the 'thinker' and 'deep-only' models. */
export async function seedActorsAndModels(
  db: Database,
  organizationId: string,
  actors: Record<UserRole, Actor>,
) {
  for (const role of ['admin', 'auditor', 'user', 'restricted'] as const) {
    const id = await seedUser(db, organizationId, {
      role,
      email: `${role}@roles.test`,
    });
    actors[role] = {
      id,
      role,
      name: `${role} person`,
      email: `${role}@roles.test`,
      image: null,
      emailVerified: true,
      organizationId,
    };
  }

  const [provider] = await db
    .insert(schema.provider)
    .values({
      organizationId,
      kind: 'openai-compatible',
      label: 'Never called',
      baseUrl: 'http://127.0.0.1:9/v1',
    })
    .returning();
  await db.insert(schema.model).values([
    {
      organizationId,
      providerId: provider!.id,
      slug: 'thinker',
      upstreamModelId: 'thinker',
      displayName: 'Thinker',
      capabilities: ['effort_control'],
      supportedEfforts: ['instant', 'low', 'high'],
      visibleToRoles: ['admin', 'auditor', 'user', 'restricted'],
      isDefault: true,
    },
    {
      organizationId,
      providerId: provider!.id,
      slug: 'deep-only',
      upstreamModelId: 'deep-only',
      displayName: 'Deep only',
      capabilities: ['effort_control', 'vision'],
      supportedEfforts: ['high'],
      visibleToRoles: ['admin', 'auditor', 'user', 'restricted'],
    },
  ]);
}

/** Helpers over the seeded people; `actors` is filled in by `seedActorsAndModels`. */
export function roleFeatureHelpers(
  state: { organizationId: string },
  actors: Record<UserRole, Actor>,
) {
  async function threadFor(role: UserRole) {
    return createThread({
      userId: actors[role].id,
      organizationId: state.organizationId,
      role,
    });
  }

  function turnInput(threadId: string, overrides: Partial<SendMessageInput> = {}) {
    return {
      threadId,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      modelSlug: 'thinker',
      webSearch: false,
      attachmentIds: [],
      temporary: false,
      trigger: 'submit-message',
      ...overrides,
    } as SendMessageInput;
  }

  async function putRole(role: UserRole, body: unknown, actor = actors.admin) {
    return call(actor, 'PUT', `/admin/roles/${role}`, body);
  }

  /** Whether the forks route lets the role past the branching check. */
  async function branchingStatus(role: UserRole): Promise<number> {
    const thread = await threadFor(role);
    // An empty body fails validation (422) only after the branching check.
    const response = await call(actors[role], 'POST', `/threads/${thread.id}/forks`, {});
    return response.status;
  }

  async function checks(role: UserRole): Promise<Record<RoleFeatureKey, 'allowed' | number>> {
    const thread = await threadFor(role);
    return {
      attachments: await outcome(() => assertAttachmentUseAllowed(role)),
      shareLinks: await outcome(() => assertShareLinkManagementAllowed(role)),
      temporaryChat: await outcome(() => assertTemporaryChatAllowed(role)),
      webSearch: await outcome(() =>
        resolveTurnContext(actors[role], turnInput(thread.id, { webSearch: true })),
      ),
      branching: (await branchingStatus(role)) === 403 ? 403 : 'allowed',
      projects: await outcome(() => assertProjectsAllowed(role)),
      memory: await outcome(() => assertMemoryAvailable(role)),
      artifacts: await outcome(() => assertArtifactsAllowed(role)),
      accountDeletion: await outcome(() => assertRoleFeature(role, 'accountDeletion')),
    };
  }

  return { threadFor, turnInput, putRole, branchingStatus, checks };
}
