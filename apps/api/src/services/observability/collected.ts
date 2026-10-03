import { count, desc, eq, isNull, schema } from '@oci/db';
import { db } from '../../db/index.js';
import { registerCollectedGauge } from './metrics.js';

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
}
