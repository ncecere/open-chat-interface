import { randomUUID } from 'node:crypto';
import { eq, schema, sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';
import {
  type AppBindings,
  type AuthenticatedUser,
  requireAdmin,
} from '../../middleware/context.js';
import { errorHandler } from '../../middleware/error-handler.js';

/**
 * Languages (v0.14, #397) against real PostgreSQL: the person's saved language
 * (a nullable column, migration 0055) through /api/me, the instance's
 * `language` setting through the administration API and the public status,
 * with the audit entry, and the behaviour when a saved language is no longer
 * enabled.
 */
const available = await livePostgresAvailable();
const state = vi.hoisted(() => ({ db: null as unknown, organizationId: '' }));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

const { meRoutes } = await import('../../routes/me.js');
const { settingsRoutes } = await import('../../routes/admin/settings.js');
const { authStatusRoutes } = await import('../../routes/auth-status.js');
const { invalidateSettingsCache, updateSetting } = await import('../../services/settings.js');

type Settings = { language?: { default: string | null; enabled: string[] } };

function appFor(actor: AuthenticatedUser | null) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (actor) {
      c.set('user', actor);
      c.set('sessionId', null);
    }
    await next();
  });
  app.use('/admin/*', requireAdmin);
  app.route('/admin/settings', settingsRoutes);
  app.route('/me', meRoutes);
  app.route('/auth', authStatusRoutes);
  return app;
}

describe.skipIf(!available)('live: languages', () => {
  let live: LiveDatabase;

  beforeAll(async () => {
    live = await createLiveDatabase('i18n_language');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    invalidateSettingsCache();
    // The public status reads the sign-in policy, which a fresh database lacks.
    await updateSetting('auth', {
      registrationMode: 'open',
      emailVerificationRequired: false,
      localAuthEnabled: true,
      sessionLifetimeDays: 30,
      sessionRefreshDays: 1,
    });
  });
  afterAll(async () => {
    invalidateSettingsCache();
    await live?.destroy();
  });

  async function person(role: 'user' | 'admin' = 'user'): Promise<AuthenticatedUser> {
    const email = `${randomUUID().slice(0, 8)}@lang.test`;
    const id = await seedUser(live.db, state.organizationId, { role, email });
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

  async function request(
    actor: AuthenticatedUser | null,
    method: string,
    path: string,
    body?: unknown,
  ) {
    return appFor(actor).request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function ok<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  const savedLocale = async (actor: AuthenticatedUser) =>
    (await ok<{ preferences: { locale: string | null } }>(await request(actor, 'GET', '/me')))
      .preferences.locale;

  describe('migration 0055: the person’s language column', () => {
    it('is a nullable text column with no default, so the previous release is unaffected', async () => {
      const [column] = await live.db.execute<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        sql`select data_type, is_nullable, column_default from information_schema.columns
            where table_name = 'user_preference' and column_name = 'locale'`,
      );
      expect(column).toEqual({ data_type: 'text', is_nullable: 'YES', column_default: null });
    });

    it('lets the previous release write a preference row without knowing the column', async () => {
      const actor = await person();
      // The v0.13 insert: its column list has no `locale`.
      await live.db.execute(
        sql`insert into user_preference (user_id, theme) values (${actor.id}, 'dark')`,
      );
      const [row] = await live.db
        .select({ locale: schema.userPreference.locale })
        .from(schema.userPreference)
        .where(eq(schema.userPreference.userId, actor.id));
      expect(row?.locale).toBeNull();
    });
  });

  describe('the person’s saved language (/api/me)', () => {
    it('is empty until chosen, saved, read back and reset', async () => {
      const actor = await person();
      expect(await savedLocale(actor)).toBeNull();

      const saved = await ok<{ preferences: { locale: string | null } }>(
        await request(actor, 'PATCH', '/me/preferences', { locale: 'es' }),
      );
      expect(saved.preferences.locale).toBe('es');
      expect(await savedLocale(actor)).toBe('es');

      await ok(await request(actor, 'PATCH', '/me/preferences', { locale: 'ar' }));
      expect(await savedLocale(actor)).toBe('ar');

      await ok(await request(actor, 'PATCH', '/me/preferences', { locale: null }));
      expect(await savedLocale(actor)).toBeNull();
    });

    it('refuses a language the app does not support, and a pseudo-locale', async () => {
      const actor = await person();
      for (const locale of ['fr', 'en-XA', 'ar-XB', 'ES', '', 12]) {
        const response = await request(actor, 'PATCH', '/me/preferences', { locale });
        expect(response.status, String(locale)).toBe(422);
      }
      expect(await savedLocale(actor)).toBeNull();
    });

    it('changes only the signed-in person’s own row', async () => {
      const mine = await person();
      const theirs = await person();
      await ok(await request(theirs, 'PATCH', '/me/preferences', { locale: 'es' }));
      // Naming someone else is ignored: the body is read for fields, not for whose row.
      await ok(
        await request(mine, 'PATCH', '/me/preferences', { locale: 'ar', userId: theirs.id }),
      );
      expect(await savedLocale(mine)).toBe('ar');
      expect(await savedLocale(theirs)).toBe('es');
    });

    it('is not reachable without signing in', async () => {
      const response = await request(null, 'PATCH', '/me/preferences', { locale: 'es' });
      expect([401, 403]).toContain(response.status);
    });
  });

  describe('the instance’s language setting', () => {
    const admin = () => person('admin');

    it('is English only until an administrator changes it, on both the admin and the public side', async () => {
      const actor = await admin();
      expect((await ok<Settings>(await request(actor, 'GET', '/admin/settings'))).language).toEqual(
        {
          default: null,
          enabled: ['en'],
        },
      );
      const status = await ok<Settings>(await request(null, 'GET', '/auth/status'));
      expect(status.language).toEqual({ default: null, enabled: ['en'] });
    });

    it('enables languages (English always), sets the default, and shows both publicly', async () => {
      const actor = await admin();
      await ok(
        await request(actor, 'PATCH', '/admin/settings', { language: { enabled: ['ar', 'es'] } }),
      );
      const after = await ok<Settings>(await request(actor, 'GET', '/admin/settings'));
      expect(after.language).toEqual({ default: null, enabled: ['en', 'es', 'ar'] });

      await ok(await request(actor, 'PATCH', '/admin/settings', { language: { default: 'es' } }));
      const status = await ok<Settings>(await request(null, 'GET', '/auth/status'));
      expect(status.language).toEqual({ default: 'es', enabled: ['en', 'es', 'ar'] });

      await ok(await request(actor, 'PATCH', '/admin/settings', { language: { default: null } }));
      expect(
        (await ok<Settings>(await request(null, 'GET', '/auth/status'))).language?.default,
      ).toBeNull();
    });

    it('records the change in the audit log with what it was and became', async () => {
      const actor = await admin();
      await ok(
        await request(actor, 'PATCH', '/admin/settings', { language: { enabled: ['en', 'es'] } }),
      );
      const entries = await live.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actorUserId, actor.id));
      const entry = entries.find((candidate) => candidate.action === 'settings.update');
      const changes = (entry!.metadata as { changes: Array<{ key: string }> }).changes;
      expect(changes.map((change) => change.key)).toContain('language.enabled');
      const enabled = changes.find((change) => change.key === 'language.enabled') as unknown as {
        before: string[];
        after: string[];
      };
      expect(enabled.before).toEqual(['en', 'es', 'ar']);
      expect(enabled.after).toEqual(['en', 'es']);
    });

    it('refuses a default that is not enabled, and disabling the default, at the field', async () => {
      const actor = await admin();
      await ok(
        await request(actor, 'PATCH', '/admin/settings', {
          language: { enabled: ['es'], default: 'es' },
        }),
      );
      const notEnabled = await request(actor, 'PATCH', '/admin/settings', {
        language: { default: 'ar' },
      });
      expect(notEnabled.status).toBe(422);
      expect(JSON.stringify(await notEnabled.json())).toContain('language');

      const disablingDefault = await request(actor, 'PATCH', '/admin/settings', {
        language: { enabled: ['en'] },
      });
      expect(disablingDefault.status).toBe(422);

      // Both at once is fine: the new default is among the new list.
      await ok(
        await request(actor, 'PATCH', '/admin/settings', {
          language: { enabled: ['en', 'ar'], default: 'ar' },
        }),
      );
    });

    it('refuses unknown languages, an empty list and unknown fields', async () => {
      const actor = await admin();
      for (const language of [
        { enabled: ['fr'] },
        { enabled: [] },
        { default: 'en-XA' },
        { enabled: ['es'], surprise: true },
      ]) {
        const response = await request(actor, 'PATCH', '/admin/settings', { language });
        expect(response.status, JSON.stringify(language)).toBe(422);
      }
    });

    it('is for administrators only', async () => {
      const user = await person('user');
      const response = await request(user, 'PATCH', '/admin/settings', {
        language: { enabled: ['en', 'es'] },
      });
      expect(response.status).toBe(403);
    });

    it('reads a stored value written by something else without failing', async () => {
      await updateSetting('language', {
        default: 'zz' as never,
        enabled: ['es', 'zz', 'es'] as never,
      });
      // updateSetting caches what it was given; the next read must come from storage.
      invalidateSettingsCache();
      const status = await ok<Settings>(await request(null, 'GET', '/auth/status'));
      expect(status.language).toEqual({ default: null, enabled: ['en', 'es'] });
    });
  });

  describe('a person whose language is switched off', () => {
    it('keeps the saved choice and reads without error; it applies again when switched on', async () => {
      const actor = await person();
      const adminActor = await person('admin');
      await ok(
        await request(adminActor, 'PATCH', '/admin/settings', {
          language: { enabled: ['en', 'ar'], default: null },
        }),
      );
      await ok(await request(actor, 'PATCH', '/me/preferences', { locale: 'ar' }));

      await ok(
        await request(adminActor, 'PATCH', '/admin/settings', { language: { enabled: ['en'] } }),
      );
      // Nothing is erased and nothing fails: the web app falls back to the default.
      expect(await savedLocale(actor)).toBe('ar');
      const status = await ok<Settings>(await request(null, 'GET', '/auth/status'));
      expect(status.language?.enabled).toEqual(['en']);

      await ok(
        await request(adminActor, 'PATCH', '/admin/settings', {
          language: { enabled: ['en', 'ar'] },
        }),
      );
      expect(await savedLocale(actor)).toBe('ar');
    });
  });
});
