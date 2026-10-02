import { eq, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../../db/index.js';
import { roleFeatures } from '../role-features.js';
import { getSetting } from '../settings.js';

/**
 * Whether memory can be used by someone in this role: the instance switch
 * (General settings, off by default) and the role's `memory` switch (on
 * except for restricted accounts). The person's own opt-in is separate.
 */
export async function memoryAvailable(role: UserRole): Promise<boolean> {
  const [features, own] = await Promise.all([getSetting('features'), roleFeatures(role)]);
  return features.memory === true && own.memory;
}

/** The person's own switch in Settings -> Memory; off when never saved. */
export async function memoryOptedIn(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: schema.userPreference.memoryEnabled })
    .from(schema.userPreference)
    .where(eq(schema.userPreference.userId, userId))
    .limit(1);
  return row?.enabled === true;
}

/**
 * Whether memories are read into this turn's prompt and the memory tools are
 * offered: every switch allows it and the chat is not temporary. A temporary
 * chat never reads or writes memory.
 */
export async function memoryActive(turn: {
  userId: string;
  role: UserRole;
  temporary: boolean;
}): Promise<boolean> {
  if (turn.temporary) return false;
  if (!(await memoryAvailable(turn.role))) return false;
  return memoryOptedIn(turn.userId);
}
