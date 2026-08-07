import { count, eq, schema } from '@oci/db';
import { auth } from './auth/index.js';
import { loadEnv } from './config/env.js';
import { db } from './db/index.js';
import { generateToken } from './lib/crypto.js';
import { logger } from './lib/logger.js';
import { recordAudit } from './services/audit.js';
import { getDefaultOrganizationId } from './services/organization.js';

const env = loadEnv();

/**
 * Creates the first administrator on an empty instance. If no password is
 * supplied a one-time setup link is written to the logs instead.
 */
export async function ensureInitialAdmin(): Promise<void> {
  const [totals] = await db.select({ value: count() }).from(schema.user);
  if ((totals?.value ?? 0) > 0) return;

  if (!env.INITIAL_ADMIN_EMAIL) {
    logger.warn(
      'No users exist and INITIAL_ADMIN_EMAIL is not set. Set it and restart to create the first administrator.',
    );
    return;
  }

  const organizationId = await getDefaultOrganizationId();
  const password = env.INITIAL_ADMIN_PASSWORD ?? generateToken(24);

  await auth.api.createUser({
    body: {
      email: env.INITIAL_ADMIN_EMAIL,
      password,
      name: 'Administrator',
      role: 'admin',
    },
  });

  await db
    .update(schema.user)
    .set({ role: 'admin', emailVerified: true, organizationId })
    .where(eq(schema.user.email, env.INITIAL_ADMIN_EMAIL));

  await recordAudit({
    action: 'instance.bootstrap',
    targetType: 'user',
    metadata: { email: env.INITIAL_ADMIN_EMAIL },
  });

  if (env.INITIAL_ADMIN_PASSWORD) {
    logger.info({ email: env.INITIAL_ADMIN_EMAIL }, 'Initial administrator created');
  } else {
    logger.info(
      `\n${'='.repeat(72)}\n` +
        `Initial administrator created.\n` +
        `  Email:    ${env.INITIAL_ADMIN_EMAIL}\n` +
        `  Password: ${password}\n` +
        `Sign in and change this password immediately.\n` +
        `${'='.repeat(72)}\n`,
    );
  }
}
