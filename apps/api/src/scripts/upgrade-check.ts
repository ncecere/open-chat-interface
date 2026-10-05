import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { upgradeReport } from '../services/migrations/preflight.js';
import { renderReport } from '../services/migrations/report-text.js';

/**
 * Upgrade preflight (v0.11 design, section 6). Run it from the image you are
 * about to deploy, against the production database, before `migrate`:
 *
 *   docker run --rm -e DATABASE_URL=... <new api image> node dist/scripts/upgrade-check.js
 *   docker compose --profile tools run --rm migrate node dist/scripts/upgrade-check.js
 *   pnpm upgrade:check            (from a checkout)
 *
 * Read-only: it reads the migration history, the catalogue (`pg_class`,
 * `pg_stats`, `pg_index`) and the post-deploy and background tables, and
 * changes nothing. Needs only DATABASE_URL. `--json` prints the report as JSON.
 *
 * Exit codes: 0 nothing to do or a rolling upgrade; 2 a maintenance window is
 * needed; 3 this release cannot upgrade the database yet; 1 the check failed.
 */

const EXIT = { current: 0, rolling: 0, window: 2, blocked: 3 } as const;

async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required.');
    return 1;
  }
  const client = postgres(connectionString, {
    max: 2,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: 'oci-upgrade-check' },
  });
  try {
    const report = await upgradeReport(client);
    console.log(
      process.argv.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report),
    );
    return EXIT[report.verdict.mode];
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(
        `Upgrade check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    });
}
