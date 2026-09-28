import { eq, schema } from '@oci/db';
import type { db } from '../../db/index.js';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Acquire before thread/file locks or counter inserts. Account deletion locks
 * this parent before cascading into those children. Sweeps may skip a busy owner;
 * interactive operations wait and discover whether the owner still exists.
 */
export async function lockLifecycleOwner(
  tx: Transaction,
  userId: string,
  skipLocked = false,
): Promise<boolean> {
  const [owner] = await tx
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .for('key share', skipLocked ? { skipLocked: true } : undefined);
  return Boolean(owner);
}
