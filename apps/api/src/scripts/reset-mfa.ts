import { sql } from '../db/index.js';
import { errorText } from '../lib/log-redaction.js';
import {
  cliResetAllAuthenticators,
  cliResetMfa,
  cliUnlockMfa,
  NoSuchPersonError,
} from '../services/mfa/reset.js';

/**
 * Getting back in when two-step verification stands in the way (v0.14, #399;
 * docs/OPERATIONS.md, "Getting back in when sign-on fails"). Usage:
 *
 *   node dist/scripts/reset-mfa.js <email>            remove their authenticator, recovery codes
 *                                                     and passkeys, and end their sessions
 *   node dist/scripts/reset-mfa.js <email> --unlock   only clear the lock after too many wrong codes
 *   node dist/scripts/reset-mfa.js --all --yes        after AUTH_SECRET changed: remove every
 *                                                     authenticator (passkeys stay)
 *
 * It decrypts nothing, so it works whatever AUTH_SECRET is. It prints no secret.
 * From a checkout: `pnpm --filter @oci/api admin:reset-mfa user@example.com`.
 */
const USAGE =
  'Usage: admin:reset-mfa <email> [--unlock]\n       admin:reset-mfa --all --yes   (after AUTH_SECRET changed: removes every authenticator)';

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const email = args
    .find((arg) => !arg.startsWith('--'))
    ?.trim()
    .toLowerCase();

  if (flags.has('--all')) {
    if (!flags.has('--yes')) {
      console.error(
        'This removes every authenticator and every recovery code, and ends every session. Add --yes to do it.',
      );
      process.exit(1);
    }
    const outcome = await cliResetAllAuthenticators();
    console.log(
      `Removed ${outcome.authenticators} authenticator(s) and ended ${outcome.sessionsEnded} session(s). Passkeys were kept.`,
    );
    return;
  }

  if (!email) {
    console.error(USAGE);
    process.exit(1);
  }

  if (flags.has('--unlock')) {
    await cliUnlockMfa(email);
    console.log(`The second step of ${email} is unlocked.`);
    return;
  }

  const outcome = await cliResetMfa(email);
  console.log(
    `Two-step verification was reset for ${outcome.email}: ${outcome.authenticator ? 'authenticator and recovery codes removed' : 'no authenticator'}, ${outcome.passkeysRemoved} passkey(s) removed, ${outcome.sessionsEnded} session(s) ended.`,
  );
}

main()
  .then(() => sql.end())
  .catch(async (error) => {
    // The message, without a failed query's parameters (#264).
    console.error(
      error instanceof NoSuchPersonError ? error.message : `Reset failed: ${errorText(error)}`,
    );
    await sql.end().catch(() => {});
    process.exit(1);
  });
