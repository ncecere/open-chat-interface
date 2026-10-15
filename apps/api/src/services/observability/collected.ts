import { count, desc, eq, isNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { archiverMetricSamples, readArchiverState } from '../backups/database-state.js';
import { backupSettings } from '../backups/settings.js';
import { mfaImpact } from '../mfa/requirement.js';
import { registerCollectedGauge } from './metrics.js';

/** The WAL archiver read, only when the database is backed up outside OCI. */
async function archiverSamples() {
  const { databaseBackup } = await backupSettings();
  if (databaseBackup !== 'external') return null;
  return archiverMetricSamples(await readArchiverState(), databaseBackup);
}

/**
 * Gauges read from the database when scraped: queue depths and the age of
 * the last good backup. Each is one indexed query; a database that does not
 * answer simply leaves them out of that scrape.
 */
export function registerCollectedGauges(): void {
  registerCollectedGauge(
    'oci_webhook_deliveries_pending',
    'Webhook deliveries waiting for a first attempt or a retry.',
    [],
    async () => {
      const [row] = await db
        .select({ total: count() })
        .from(schema.webhookDelivery)
        .where(eq(schema.webhookDelivery.status, 'pending'));
      return [{ value: row?.total ?? 0 }];
    },
  );
  registerCollectedGauge(
    'oci_storage_deletions_pending',
    'Stored objects queued for deletion.',
    [],
    async () => {
      const [row] = await db
        .select({ total: count() })
        .from(schema.deletedObject)
        .where(isNull(schema.deletedObject.deletedAt));
      return [{ value: row?.total ?? 0 }];
    },
  );
  registerCollectedGauge(
    'oci_backup_last_success_timestamp_seconds',
    'When the last successful backup finished (Unix seconds); absent when there has been none.',
    [],
    async () => {
      const [row] = await db
        .select({ finishedAt: schema.backupRun.finishedAt })
        .from(schema.backupRun)
        .where(eq(schema.backupRun.status, 'succeeded'))
        .orderBy(desc(schema.backupRun.finishedAt))
        .limit(1);
      return row?.finishedAt ? [{ value: Math.floor(row.finishedAt.getTime() / 1000) }] : [];
    },
  );
  // Samples exist only with `databaseBackup: 'external'` (and a readable
  // pg_stat_archiver); in dump mode the series are absent.
  registerCollectedGauge(
    'oci_wal_archive_last_success_timestamp_seconds',
    'When PostgreSQL last archived a WAL segment (Unix seconds), read from pg_stat_archiver; only with an external database backup, absent when none was archived.',
    [],
    async () => {
      const samples = await archiverSamples();
      return samples?.lastSuccessSeconds != null ? [{ value: samples.lastSuccessSeconds }] : [];
    },
  );
  registerCollectedGauge(
    'oci_wal_archive_failing',
    '1 when the newest WAL archive attempt failed after the newest success, else 0; only with an external database backup.',
    [],
    async () => {
      const samples = await archiverSamples();
      return samples ? [{ value: samples.failing }] : [];
    },
  );
  // Two-step verification (v0.14, #399): who has it, and who the requirement
  // limits. Roles are the four fixed ones; never a person.
  registerCollectedGauge(
    'oci_mfa_people',
    'Unbanned accounts by role and two-step verification state: enrolled (authenticator or passkey), not_enrolled, exempt (no password, so never required to).',
    ['role', 'state'],
    async () =>
      (await mfaImpact()).roles.flatMap((row) => [
        { labels: { role: row.role, state: 'enrolled' }, value: row.enrolled },
        { labels: { role: row.role, state: 'not_enrolled' }, value: row.unenrolled },
        { labels: { role: row.role, state: 'exempt' }, value: row.exempt },
      ]),
  );
  registerCollectedGauge(
    'oci_mfa_limited_people',
    'People whose role requires two-step verification, who have not set it up and whose grace has passed: refused everywhere but setup until they do.',
    ['role'],
    async () =>
      (await mfaImpact()).roles.map((row) => ({
        labels: { role: row.role },
        value: row.limitedNow,
      })),
  );
}
