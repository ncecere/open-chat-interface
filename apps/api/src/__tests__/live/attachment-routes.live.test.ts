import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from '@oci/db';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Exercises the upload route itself rather than the validators beneath it.
 * Uploads are the largest untrusted input surface in the application, and the
 * route is where the per-request size cap, the file-count cap, role
 * enforcement, and ownership are actually applied.
 */
const available = await livePostgresAvailable();

const storageRoot = mkdtempSync(join(tmpdir(), 'oci-attach-route-'));

// The routes resolve the database and settings through these modules, so the
// suite points them at a throwaway database and local storage directory.
const state = vi.hoisted(() => ({
  db: null as unknown,
  organizationId: '',
  maxFilesPerMessage: 10,
  maxFileBytes: 20 * 1024 * 1024,
  role: 'user' as 'admin' | 'user' | 'restricted',
  attachmentsEnabled: true,
}));

vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
}));

vi.mock('../../services/organization.js', () => ({
  getDefaultOrganizationId: async () => state.organizationId,
}));

vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (key === 'storage') {
      return {
        driver: 'local',
        maxFileBytes: state.maxFileBytes,
        maxFilesPerMessage: state.maxFilesPerMessage,
        allowedMimeTypes: ['image/png', 'application/json', 'text/plain'],
        s3: {
          bucket: '',
          region: 'us-east-1',
          endpoint: null,
          accessKeyId: '',
          encryptedSecretAccessKey: null,
          forcePathStyle: false,
        },
      };
    }
    if (key === 'features') return { attachments: state.attachmentsEnabled };
    return {};
  },
  invalidateSettingsCache: () => {},
}));

// Redirect only the storage path; other consumers still need the real values.
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), STORAGE_LOCAL_PATH: storageRoot }),
  };
});

const { attachmentRoutes } = await import('../../routes/attachments.js');
type AppBindings = import('../../middleware/context.js').AppBindings;
const { errorHandler } = await import('../../middleware/error-handler.js');

/** A single-byte-accurate PNG, so magic-byte detection sees a real image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function appFor(userId: string) {
  const app = new Hono<AppBindings>();
  app.onError(errorHandler);
  // requireAuth only reads this context value, so injecting it exercises the
  // real route without standing up Better Auth.
  app.use('*', async (c, next) => {
    c.set('user', {
      id: userId,
      email: 'user@example.com',
      name: 'User',
      image: null,
      role: state.role,
      emailVerified: true,
      organizationId: state.organizationId,
    });
    await next();
  });
  app.route('/api/attachments', attachmentRoutes);
  return app;
}

function upload(files: Array<{ name: string; type: string; body: Buffer }>): FormData {
  const form = new FormData();
  for (const file of files) {
    form.append('files', new File([new Uint8Array(file.body)], file.name, { type: file.type }));
  }
  return form;
}

describe.skipIf(!available)('live: attachment upload route', () => {
  let live: LiveDatabase;
  let userId: string;
  let strangerId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('attachments');
    state.db = live.db;
    state.organizationId = await seedOrganization(live.db);
    userId = await seedUser(live.db, state.organizationId);
    strangerId = await seedUser(live.db, state.organizationId, { email: 'other@example.com' });
  });

  afterAll(async () => {
    await live?.destroy();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.maxFilesPerMessage = 10;
    state.maxFileBytes = 20 * 1024 * 1024;
    state.role = 'user';
    state.attachmentsEnabled = true;
  });

  it('stores an uploaded file and returns its metadata', async () => {
    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'pixel.png', type: 'image/png', body: PNG }]),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      attachments: Array<{ id: string; mimeType: string }>;
    };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.mimeType).toBe('image/png');

    const rows = await live.db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from attachment where user_id = ${userId}`,
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('serves the stored bytes back unchanged to the owner', async () => {
    const app = appFor(userId);
    const created = await app.request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'pixel.png', type: 'image/png', body: PNG }]),
    });
    const { attachments } = (await created.json()) as { attachments: Array<{ id: string }> };
    const id = attachments[0]?.id;

    const response = await app.request(`/api/attachments/${id}/content`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('refuses to serve another user\u2019s attachment', async () => {
    const created = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'pixel.png', type: 'image/png', body: PNG }]),
    });
    const { attachments } = (await created.json()) as { attachments: Array<{ id: string }> };

    const response = await appFor(strangerId).request(
      `/api/attachments/${attachments[0]?.id}/content`,
    );
    // Ownership is enforced on every read, not just at upload time.
    expect(response.status).toBe(404);
  });

  it('rejects a request carrying no files', async () => {
    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: new FormData(),
    });
    expect(response.status).toBe(422);
  });

  it('rejects more files than the configured per-message cap', async () => {
    state.maxFilesPerMessage = 2;

    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload(
        Array.from({ length: 3 }, (_, index) => ({
          name: `pixel-${index}.png`,
          type: 'image/png',
          body: PNG,
        })),
      ),
    });
    expect(response.status).toBe(422);
  });

  it('records the detected type, not a contradicting declared one', async () => {
    // A PNG renamed to .json is stored as an image. Trusting the declared type
    // instead would let a caller smuggle bytes past a MIME allowlist.
    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'not-really.json', type: 'application/json', body: PNG }]),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { attachments: Array<{ mimeType: string }> };
    expect(body.attachments[0]?.mimeType).toBe('image/png');
  });

  it('rejects bytes matching no recognized or textual format', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x99]);

    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'mystery.bin', type: 'application/octet-stream', body: binary }]),
    });
    expect(response.status).toBe(422);
  });

  it('rejects a file larger than the configured size limit', async () => {
    state.maxFileBytes = 128;

    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'big.txt', type: 'text/plain', body: Buffer.alloc(512, 0x61) }]),
    });
    expect(response.status).toBe(422);
  });

  it('refuses uploads when the attachments feature is disabled', async () => {
    state.attachmentsEnabled = false;

    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'pixel.png', type: 'image/png', body: PNG }]),
    });
    // A disabled instance feature is reported as a policy failure; a
    // disallowed role is reported as forbidden.
    expect(response.status).toBe(422);
  });

  it('refuses uploads from a restricted role', async () => {
    state.role = 'restricted';

    const response = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'pixel.png', type: 'image/png', body: PNG }]),
    });
    expect(response.status).toBe(403);
  });

  it('deletes only the caller\u2019s own attachment', async () => {
    const created = await appFor(userId).request('/api/attachments', {
      method: 'POST',
      body: upload([{ name: 'pixel.png', type: 'image/png', body: PNG }]),
    });
    const { attachments } = (await created.json()) as { attachments: Array<{ id: string }> };
    const id = attachments[0]?.id;

    const byStranger = await appFor(strangerId).request(`/api/attachments/${id}`, {
      method: 'DELETE',
    });
    expect(byStranger.status).toBe(404);

    const byOwner = await appFor(userId).request(`/api/attachments/${id}`, { method: 'DELETE' });
    expect(byOwner.status).toBe(200);

    const rows = await live.db.execute<{ count: string }>(
      sql`select count(*)::bigint as count from attachment where id = ${id}`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
