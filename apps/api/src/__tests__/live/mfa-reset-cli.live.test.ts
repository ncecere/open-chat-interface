import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createDatabase, eq, schema } from '@oci/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * `admin:reset-mfa` as an operator runs it (docs/OPERATIONS.md, "Getting back
 * in when sign-on fails"): the real script in a child process against a real
 * database, with its arguments, output and exit codes. The reset itself is
 * covered in mfa-requirement.live.test.ts; this is the command line.
 */
const run = promisify(execFile);
const available = await livePostgresAvailable();
const SECRET_CANARY = 'CANARY-SECRET-0123456789ABCDEF';

describe.skipIf(!available)('live: the reset-mfa command', { timeout: 120_000 }, () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let organizationId: string;

  beforeAll(async () => {
    live = await createLiveDatabase('mfa_reset_cli');
    pool = createDatabase(live.connectionString, { max: 4 });
    organizationId = await seedOrganization(pool.db);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 5 });
    await live?.destroy();
  });

  async function command(args: string[]) {
    try {
      const { stdout, stderr } = await run(
        'pnpm',
        ['exec', 'tsx', 'src/scripts/reset-mfa.ts', ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: live.connectionString, NODE_ENV: 'test' },
          timeout: 90_000,
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  }

  async function enrolledRow() {
    const id = await seedUser(pool.db, organizationId);
    const [found] = await pool.db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.id, id))
      .returning({ email: schema.user.email });
    await pool.db.insert(schema.twoFactor).values({
      userId: id,
      secret: SECRET_CANARY,
      backupCodes: SECRET_CANARY,
      failedVerificationCount: 10,
      lockedUntil: new Date(Date.now() + 600_000),
    });
    await pool.db.insert(schema.passkey).values({
      userId: id,
      publicKey: 'key',
      credentialID: randomUUID(),
      counter: 3,
      deviceType: 'singleDevice',
      backedUp: false,
    });
    await pool.db.insert(schema.session).values({
      id: randomUUID(),
      userId: id,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { id, email: found?.email ?? '' };
  }

  it('prints the usage and exits 1 without an address, and refuses --all without --yes', async () => {
    const none = await command([]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('Usage: admin:reset-mfa <email>');
    const all = await command(['--all']);
    expect(all.code).toBe(1);
    expect(all.stderr).toContain('Add --yes');
  });

  it('exits 1 for an address with no account, and changes nothing', async () => {
    const target = await enrolledRow();
    const response = await command(['nobody@example.test']);
    expect(response.code).toBe(1);
    expect(response.stderr).toContain('No user found with email nobody@example.test');
    expect(
      await pool.db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, target.id)),
    ).toHaveLength(1);
  });

  it('--unlock clears only the lock', async () => {
    const target = await enrolledRow();
    const response = await command([target.email, '--unlock']);
    expect(response.code).toBe(0);
    expect(response.stdout).toContain(`The second step of ${target.email} is unlocked.`);
    const [row] = await pool.db
      .select()
      .from(schema.twoFactor)
      .where(eq(schema.twoFactor.userId, target.id));
    expect(row).toMatchObject({ failedVerificationCount: 0, lockedUntil: null });
    expect(
      await pool.db.select().from(schema.passkey).where(eq(schema.passkey.userId, target.id)),
    ).toHaveLength(1);
    expect(
      await pool.db.select().from(schema.session).where(eq(schema.session.userId, target.id)),
    ).toHaveLength(1);
  });

  it('resets one person, prints no secret, audits it, and works whatever AUTH_SECRET is (it decrypts nothing)', async () => {
    const target = await enrolledRow();
    const response = await command([target.email.toUpperCase()]);
    expect(response.code).toBe(0);
    expect(response.stdout).toContain(`Two-step verification was reset for ${target.email}`);
    expect(response.stdout).toContain('1 passkey(s) removed, 1 session(s) ended');
    expect(response.stdout + response.stderr).not.toContain(SECRET_CANARY);
    expect(
      await pool.db.select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, target.id)),
    ).toHaveLength(0);
    expect(
      await pool.db.select().from(schema.passkey).where(eq(schema.passkey.userId, target.id)),
    ).toHaveLength(0);
    expect(
      await pool.db.select().from(schema.session).where(eq(schema.session.userId, target.id)),
    ).toHaveLength(0);
    const [user] = await pool.db.select().from(schema.user).where(eq(schema.user.id, target.id));
    expect(user?.twoFactorEnabled).toBe(false);
    const events = await pool.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'user.mfa_reset_cli'));
    expect(events.find((event) => event.targetId === target.id)?.metadata).toMatchObject({
      mode: 'reset',
    });
    expect(JSON.stringify(events)).not.toContain(SECRET_CANARY);
  });

  it('--all --yes removes every authenticator and keeps the passkeys', async () => {
    const one = await enrolledRow();
    const two = await enrolledRow();
    const response = await command(['--all', '--yes']);
    expect(response.code).toBe(0);
    expect(response.stdout).toContain('Passkeys were kept');
    expect(await pool.db.select().from(schema.twoFactor)).toHaveLength(0);
    for (const person of [one, two])
      expect(
        await pool.db.select().from(schema.passkey).where(eq(schema.passkey.userId, person.id)),
      ).toHaveLength(1);
  });
});
