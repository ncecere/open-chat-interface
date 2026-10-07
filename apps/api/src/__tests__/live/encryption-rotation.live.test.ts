import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createDatabase,
  runPostMigrations,
  schema,
  secretReencryptionMigrations,
  setSecretCodec,
  sql,
} from '@oci/db';
import { generateText } from 'ai';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { liveS3Available, liveS3Config } from '../../../test/live-backup-tools.js';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Encryption key rotation end to end (v0.11 design, item 23), against a real
 * database: every table holding values encrypted with ENCRYPTION_KEY is
 * filled with values written the way v0.10 wrote them, the key is rotated
 * (new ENCRYPTION_KEY, the old one in ENCRYPTION_KEYS_PREVIOUS), the
 * background re-encryption runs (resuming after a batch that dies half-way),
 * and then, with the old key removed, the application still uses every
 * secret: a model call to a stub provider that checks the key, a person's
 * connector token, a connector's shared credential, the backup destination's
 * S3 credential and a webhook's signing secret.
 */
const OLD = 'old-encryption-key-with-at-least-32-characters';
const NEW = 'new-encryption-key-with-at-least-32-characters';
const state = vi.hoisted(() => ({
  db: null as unknown,
  sql: null as unknown,
  key: 'old-encryption-key-with-at-least-32-characters',
  previous: undefined as string | undefined,
}));
vi.mock('../../db/index.js', () => ({
  get db() {
    return state.db;
  },
  get sql() {
    return state.sql;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      ENCRYPTION_KEY: state.key,
      ENCRYPTION_KEYS_PREVIOUS: state.previous,
    }),
  };
});

const available = await livePostgresAvailable();
// The backup credential is checked against a real S3-compatible server when
// there is one (CI always has one); otherwise against the client's config.
const s3 = available ? await liveS3Available() : false;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!available)('live: rotating ENCRYPTION_KEY', { timeout: 120_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let stub: Server;
  let stubUrl = '';
  const seenKeys: string[] = [];
  let organizationId = '';
  let userId = '';
  const ids = { provider: '', connector: '', webhook: '' };
  const PEOPLE = 450;

  let crypto: typeof import('../../lib/crypto.js');
  let rotation: typeof import('../../services/encryption/rotation.js');
  let runner: typeof import('../../services/migrations/background-runner.js');

  beforeAll(async () => {
    live = await createLiveDatabase('encryption_rotation');
    pool = createDatabase(live.connectionString, { max: 6 });
    state.db = pool.db;
    state.sql = pool.sql;
    organizationId = await seedOrganization(pool.db);
    userId = await seedUser(pool.db, organizationId);
    crypto = await import('../../lib/crypto.js');
    rotation = await import('../../services/encryption/rotation.js');
    runner = await import('../../services/migrations/background-runner.js');

    // An OpenAI-compatible provider that answers only with the right key.
    stub = createServer((request, response) => {
      const key = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      seenKeys.push(key);
      if (key !== 'sk-provider-secret') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad key' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          created: 1,
          model: 'stub',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    setSecretCodec(null);
    crypto?.setVersionedCiphertext(false);
    await new Promise((resolve) => stub?.close(resolve));
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  async function seed() {
    const { encryptSecret } = crypto;
    const [provider] = await pool.db
      .insert(schema.provider)
      .values({
        organizationId,
        kind: 'openai-compatible',
        label: 'Stub',
        baseUrl: stubUrl,
        encryptedApiKey: encryptSecret('sk-provider-secret'),
      })
      .returning({ id: schema.provider.id });
    ids.provider = provider!.id;
    await pool.db.insert(schema.model).values({
      organizationId,
      providerId: ids.provider,
      slug: 'stub-model',
      upstreamModelId: 'stub',
      displayName: 'Stub',
    });
    const [connector] = await pool.db
      .insert(schema.connector)
      .values({
        organizationId,
        name: 'Files',
        slug: 'files',
        url: 'https://mcp.example.test/mcp',
        authMode: 'oauth',
        encryptedSharedHeaderValue: encryptSecret('Bearer shared-header-secret'),
        oauthClientId: 'client-1',
        encryptedOauthClientSecret: encryptSecret('oauth-client-secret'),
      })
      .returning({ id: schema.connector.id });
    ids.connector = connector!.id;
    // Many people's tokens, so the re-encryption takes several batches.
    const people = [userId];
    for (let index = 1; index < PEOPLE; index++) {
      people.push(await seedUser(pool.db, organizationId, { email: `p${index}@campus.test` }));
    }
    await pool.db.insert(schema.connectorAccount).values(
      people.map((person, index) => ({
        connectorId: ids.connector,
        userId: person,
        encryptedTokens: encryptSecret(
          JSON.stringify({
            tokens: { access_token: `access-${index}`, token_type: 'Bearer' },
            client: { client_id: 'client-1' },
          }),
        ),
        encryptedPending: index % 3 === 0 ? encryptSecret(`pending-${index}`) : null,
      })),
    );
    const [webhook] = await pool.db
      .insert(schema.webhookEndpoint)
      .values({
        organizationId,
        url: 'https://hooks.example.test/oci',
        encryptedSecret: encryptSecret('whsec-signing-secret'),
      })
      .returning({ id: schema.webhookEndpoint.id });
    ids.webhook = webhook!.id;
    const settings = await import('../../services/settings.js');
    await settings.updateSetting('backups', {
      enabled: true,
      destination: 'separate',
      prefix: 'oci-backups',
      s3: {
        bucket: liveS3Config.bucket,
        region: liveS3Config.region,
        endpoint: liveS3Config.endpoint,
        accessKeyId: liveS3Config.accessKeyId,
        encryptedSecretAccessKey: encryptSecret(liveS3Config.secretAccessKey),
        forcePathStyle: true,
      },
    });
    await settings.updateSetting('smtp', { encryptedPassword: encryptSecret('smtp-password') });
    settings.invalidateSettingsCache();
  }

  /** Every stored secret decrypted, by where it lives. */
  async function everySecret(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const { decryptSecret } = crypto;
    const [provider] = await pool.db.select().from(schema.provider);
    out.set('provider', decryptSecret(provider!.encryptedApiKey!));
    const [connector] = await pool.db.select().from(schema.connector);
    out.set('connector.shared', decryptSecret(connector!.encryptedSharedHeaderValue!));
    out.set('connector.client', decryptSecret(connector!.encryptedOauthClientSecret!));
    for (const account of await pool.db.select().from(schema.connectorAccount)) {
      out.set(`tokens:${account.userId}`, decryptSecret(account.encryptedTokens!));
      if (account.encryptedPending)
        out.set(`pending:${account.userId}`, decryptSecret(account.encryptedPending));
    }
    const [webhook] = await pool.db.select().from(schema.webhookEndpoint);
    out.set('webhook', decryptSecret(webhook!.encryptedSecret));
    for (const row of await pool.db.select().from(schema.instanceSetting)) {
      const { encryptedJsonValues } = await import('@oci/db');
      encryptedJsonValues(row.value).forEach((value, index) => {
        out.set(`setting:${row.key}:${index}`, decryptSecret(value));
      });
    }
    return out;
  }

  const run = (definitions = [...secretReencryptionMigrations]) =>
    runner.runBackgroundMigrations({
      client: pool.sql,
      definitions,
      throttle: async () => null,
      shouldStop: () => false,
      retryDelayMs: 0,
      budgetMs: 30_000,
    });

  it('keeps the format v0.10 reads until every replica runs v0.11', async () => {
    await seed();
    const usage = await rotation.encryptionKeyUsage(pool.sql);
    expect(usage.total).toBe(3 + PEOPLE + PEOPLE / 3 + 1 + 2);
    expect(usage.stale).toBe(usage.total);
    // Not yet: no post-deploy step has run, so a v0.10 replica may be running.
    expect(await rotation.refreshCiphertextFormat()).toBe(false);
    expect(crypto.encryptSecret('x').startsWith(crypto.CIPHERTEXT_PREFIX)).toBe(false);
    expect(await rotation.scheduleReencryption(pool.sql)).toBe(0);
    // Says what is happening (the older format, not a previous key) and what
    // to run, as a warning: a new install has not finished setup until then.
    expect(await rotation.encryptionHealthCheck(pool.sql)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining(
        `${usage.total} values stored in the format before v0.11, because the post-deploy phase has not run`,
      ),
    });
  });

  it('re-encrypts every value into the versioned format after migrate --post', async () => {
    const before = await everySecret();
    // migrate --post: the post-deploy steps, then the background migrations scheduled.
    const post = await runPostMigrations(live.connectionString, {
      logger: quiet,
      backgroundMigrations: [...secretReencryptionMigrations],
    });
    expect(post.scheduled).toEqual(secretReencryptionMigrations.map((entry) => entry.name));
    const { resetPreviousReleaseCache } = await import('../../services/embeddings/generations.js');
    resetPreviousReleaseCache();
    expect(await rotation.refreshCiphertextFormat()).toBe(true);
    expect(crypto.encryptSecret('x').startsWith(crypto.currentCiphertextPrefix())).toBe(true);

    rotation.registerSecretCodec();
    await run();
    const usage = await rotation.encryptionKeyUsage(pool.sql);
    expect(usage.stale).toBe(0);
    expect(usage.unknown).toBe(0);
    expect(usage.locations.reduce((sum, entry) => sum + entry.current, 0)).toBe(usage.total);
    expect(await everySecret()).toEqual(before);
  });

  it('rotates to a new key, resuming after a batch that dies half-way', async () => {
    const before = await everySecret();
    state.key = NEW;
    state.previous = OLD;
    const oldId = crypto.encryptionKeyId(OLD);
    const usage = await rotation.encryptionKeyUsage(pool.sql);
    expect(usage.locations.find((entry) => entry.table === 'connector_account')?.previous).toEqual({
      [oldId]: PEOPLE + PEOPLE / 3,
    });
    expect(await rotation.encryptionHealthCheck(pool.sql)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining(`Previous keys still in use: ${usage.total} values`),
    });

    // The job sees values under a previous key and starts every finished one again.
    expect(await rotation.scheduleReencryption(pool.sql)).toBe(secretReencryptionMigrations.length);

    // A crash in the middle of the second batch of people's tokens.
    let calls = 0;
    setSecretCodec({
      isCurrent: crypto.isCurrentCiphertext,
      reencrypt: (value) => {
        calls += 1;
        if (calls === 300) throw new Error('simulated crash mid-batch');
        return crypto.reencryptSecret(value);
      },
    });
    const tokens = secretReencryptionMigrations.find(
      (entry) => entry.name === '0.11.reencrypt-connector-tokens',
    )!;
    await run([{ ...tokens, batchSize: 200 }]);
    const [stopped] = await pool.sql<
      { status: string; batches: number; attempts: number; last_error: string }[]
    >`select status, batches, attempts, last_error from background_migration where name = ${tokens.name}`;
    expect(stopped).toMatchObject({ status: 'running', batches: 1, attempts: 1 });
    expect(stopped!.last_error).toMatch(/simulated crash mid-batch/);
    // The first batch committed with its cursor; nothing of the second did.
    const half = await rotation.encryptionKeyUsage(pool.sql);
    const accounts = half.locations.find((entry) => entry.table === 'connector_account')!;
    const [firstBatch] = await pool.sql<{ values: number }[]>`
      select (count(encrypted_tokens) + count(encrypted_pending))::integer as values
      from (select * from connector_account order by id limit 200) batch`;
    expect(accounts.current).toBe(firstBatch!.values);

    // Resumed from the cursor by the next tick, with the real codec.
    rotation.registerSecretCodec();
    await run();
    const after = await rotation.encryptionKeyUsage(pool.sql);
    expect(after.stale).toBe(0);
    expect(after.total).toBe(usage.total);

    // The old key can go: everything still decrypts without it.
    state.previous = undefined;
    expect(await rotation.encryptionHealthCheck(pool.sql)).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('Previous keys still in use: none'),
    });
    expect(await everySecret()).toEqual(before);
  });

  it('still uses every secret with only the new key configured', async () => {
    const settings = await import('../../services/settings.js');
    settings.invalidateSettingsCache();

    // A model call: the provider's key, decrypted and sent to the stub.
    const { resolveModelForRole } = await import('../../services/models.js');
    const resolved = await resolveModelForRole('stub-model', 'user');
    const reply = await generateText({ model: resolved.languageModel, prompt: 'ping' });
    expect(reply.text).toBe('pong');
    expect(seenKeys.at(-1)).toBe('sk-provider-secret');

    // A person's connector token and the shared credential.
    const { connectionAuthFor } = await import('../../services/connectors/oauth.js');
    const [connector] = await pool.db.select().from(schema.connector);
    const auth = await connectionAuthFor(connector!, userId);
    expect(auth.authProvider?.tokens()).toMatchObject({ access_token: 'access-0' });
    const shared = await connectionAuthFor({ ...connector!, authMode: 'shared' }, userId);
    expect(shared.headers).toEqual({ Authorization: 'Bearer shared-header-secret' });

    // The backup destination's S3 credential.
    const { backupSettings, resolveBackupTarget } = await import(
      '../../services/backups/settings.js'
    );
    const target = await resolveBackupTarget(await backupSettings());
    expect(target.bucket).toBe(liveS3Config.bucket);
    if (s3) {
      // Signed with the decrypted secret: S3 refuses a wrong one.
      await expect(
        (target.driver as unknown as { checkReadAccess: () => Promise<void> }).checkReadAccess(),
      ).resolves.toBeUndefined();
    } else {
      const client = (
        target.driver as unknown as {
          client: { config: { credentials: () => Promise<{ secretAccessKey: string }> } };
        }
      ).client;
      expect((await client.config.credentials()).secretAccessKey).toBe(
        liveS3Config.secretAccessKey,
      );
    }

    // Rewritten under the new key.
    const [row] = await pool.db.execute<{ encrypted_secret: string }>(
      sql`select encrypted_secret from webhook_endpoint`,
    );
    expect(row!.encrypted_secret.startsWith(crypto.currentCiphertextPrefix())).toBe(true);
    expect(crypto.decryptSecret(row!.encrypted_secret)).toBe('whsec-signing-secret');
  });

  it('reports a value under a key nobody configured, and the re-encryption fails clearly', async () => {
    state.key = OLD;
    const stray = crypto.encryptSecretVersioned('sk-stray');
    state.key = NEW;
    await pool.sql`update provider set encrypted_api_key = ${stray}`;
    expect(await rotation.encryptionHealthCheck(pool.sql)).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('1 stored secret need a key'),
    });
    const providerKeys = secretReencryptionMigrations.find(
      (entry) => entry.name === '0.11.reencrypt-provider-keys',
    )!;
    await pool.sql`
      update background_migration set status = 'pending', cursor = null where name = ${providerKeys.name}`;
    await run([providerKeys]);
    const [failed] = await pool.sql<{ last_error: string }[]>`
      select last_error from background_migration where name = ${providerKeys.name}`;
    expect(failed!.last_error).toContain(`provider.encrypted_api_key of row ${ids.provider}`);
    expect(failed!.last_error).toContain(crypto.encryptionKeyId(OLD));
    expect(failed!.last_error).not.toContain('sk-stray');
  });
});
