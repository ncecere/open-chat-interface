import { schema, sql } from '@oci/db';

/** Only unclaimed reservations become eligible for recovery after this age. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;
export const SWEEP_BATCH_SIZE = 200;

export function livePendingCutoff(now: Date): Date {
  return new Date(now.getTime() - RESERVATION_TTL_MS);
}

/**
 * New chat reservations share the durable assistant claim's ID. A reply
 * continued after an approval reserves as `<message id>:<suffix>`.
 */
export function activeChatClaim() {
  return sql<boolean>`exists (select 1 from ${schema.message}
    where ${schema.message.id} = split_part(${schema.usageEvent.id}, ':', 1)
      and ${schema.message.userId} = ${schema.usageEvent.userId}
      and ${schema.message.role} = 'assistant'
      and ${schema.message.status} = 'streaming')`;
}
