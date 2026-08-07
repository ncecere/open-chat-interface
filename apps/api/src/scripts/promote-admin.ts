import { eq, schema } from '@oci/db';
import { db, sql } from '../db/index.js';
import { recordAudit } from '../services/audit.js';

/**
 * Lockout recovery. Usage:
 *   pnpm --filter @oci/api admin:promote user@example.com
 */
async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error('Usage: admin:promote <email>');
    process.exit(1);
  }

  const [user] = await db
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.email, email))
    .limit(1);

  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }

  await db
    .update(schema.user)
    .set({ role: 'admin', banned: false, banReason: null })
    .where(eq(schema.user.id, user.id));

  await recordAudit({
    action: 'user.promote_cli',
    targetType: 'user',
    targetId: user.id,
    metadata: { email },
  });

  console.log(`${email} is now an administrator.`);
  await sql.end();
}

main().catch((error) => {
  console.error('Promotion failed:', error);
  process.exit(1);
});
