import { type Database, eq, schema } from '@oci/db';
import type { ProjectSummary, ThreadSummary } from '@oci/shared';
import { Hono } from 'hono';
import { expect } from 'vitest';
import type { AppBindings } from '../src/middleware/context.js';

/**
 * Shared fixtures for the live project suites (projects-*.live.test.ts): the
 * app under test and helpers over the project, thread and storage routes.
 * Each suite declares its own `vi.mock` block and `state`, imports the routes
 * after its mocks, and passes both in here.
 */
export interface ProjectsState {
  organizationId: string;
  role: 'admin' | 'user' | 'restricted';
}

export interface ProjectsDependencies {
  state: ProjectsState;
  routes: {
    projectRoutes: typeof import('../src/routes/projects.js').projectRoutes;
    threadRoutes: typeof import('../src/routes/threads.js').threadRoutes;
    attachmentRoutes: typeof import('../src/routes/attachments.js').attachmentRoutes;
    portabilityRoutes: typeof import('../src/routes/portability.js').portabilityRoutes;
  };
  errorHandler: typeof import('../src/middleware/error-handler.js').errorHandler;
  /** The live database; read when a helper needs it. */
  db: () => Database;
}

export function projectsHelpers({ state, routes, errorHandler, db }: ProjectsDependencies) {
  function appFor(userId: string) {
    const app = new Hono<AppBindings>();
    app.onError(errorHandler);
    app.use('*', async (c, next) => {
      c.set('user', {
        id: userId,
        email: `${userId}@example.com`,
        name: 'Person',
        image: null,
        role: state.role,
        emailVerified: true,
        organizationId: state.organizationId,
      });
      await next();
    });
    app.route('/api/projects', routes.projectRoutes);
    app.route('/api/threads', routes.threadRoutes);
    app.route('/api/attachments', routes.attachmentRoutes);
    app.route('/api/me', routes.portabilityRoutes);
    return app;
  }

  async function call(userId: string, method: string, path: string, body?: unknown) {
    return appFor(userId).request(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function json<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  function form(files: Array<{ name: string; body: string }>): FormData {
    const data = new FormData();
    for (const file of files) {
      data.append('files', new File([file.body], file.name, { type: 'text/plain' }));
    }
    return data;
  }

  async function uploadTo(userId: string, projectId: string, name: string, body: string) {
    return appFor(userId).request(`/api/projects/${projectId}/files`, {
      method: 'POST',
      body: form([{ name, body }]),
    });
  }

  async function createProject(userId: string, name: string, instructions = '') {
    const body = await json<{ project: ProjectSummary }>(
      await call(userId, 'POST', '/projects', { name, instructions }),
      201,
    );
    return body.project;
  }

  async function createThread(userId: string, extra: Record<string, unknown> = {}) {
    const body = await json<{ thread: ThreadSummary }>(
      await call(userId, 'POST', '/threads', { title: 'A conversation', ...extra }),
      201,
    );
    return body.thread;
  }

  async function usage(userId: string) {
    const [row] = await db()
      .select()
      .from(schema.storageUsage)
      .where(eq(schema.storageUsage.userId, userId));
    return { bytes: Number(row?.liveBytes ?? 0), files: Number(row?.liveFileCount ?? 0) };
  }

  return { appFor, call, json, form, uploadTo, createProject, createThread, usage };
}
