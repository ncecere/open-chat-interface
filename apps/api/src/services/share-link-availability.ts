import { and, eq, isNull, or, schema, sql } from '@oci/db';

/** Public availability is enforced on reads, not deferred to cleanup jobs. */
export function shareableThreadCondition() {
  return and(
    isNull(schema.thread.deletedAt),
    or(
      eq(schema.thread.temporary, false),
      // A temporary thread without an expiry fails closed. Use wall-clock time:
      // PostgreSQL now() is fixed at transaction start, even after lock waits.
      sql`${schema.thread.expiresAt} > clock_timestamp()`,
    ),
  );
}
