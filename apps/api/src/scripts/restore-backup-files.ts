import { runRestoreFilesCli } from '../services/backups/restore-files.js';

/**
 * Restores attachment files from a backup that copied them. Usage:
 *   pnpm --filter @oci/api backup:restore-files <backup folder> --to-local <dir> | --to-s3
 * Credentials come from BACKUP_S3_* (and TARGET_S3_*) variables; run with
 * --help for the full list. See docs/admin/backups.md, "Restoring".
 */
process.exitCode = await runRestoreFilesCli(process.argv.slice(2), process.env, (line) =>
  console.log(line),
);
