import { ATTACHMENT_OWN_ROWS, descendantsOf, ownRowsStatement, sql } from '@oci/db';
import type { db } from '../../db/index.js';
import { isBackgroundMigrationDone } from '../migrations/readiness.js';

/**
 * Forks and edits made before 0.11 share their files' attachment ids with the
 * conversation they came from (#358); release 0.11 gives each its own row, for
 * new ones at once and for these in the background migration
 * `0.11.attachment-own-rows`. Until that has finished, anything that deletes
 * files first gives the conversations that still share them their own rows, in
 * the same transaction, so a deletion never takes a file another conversation
 * shows. Afterwards nothing shares a file, and this does nothing at all.
 *
 * It finds those conversations through copy lineage (a copied message names
 * its source in `parent_message_id`), which is cheap and covers every fork and
 * edit; the background migration reads every message and catches the rest.
 */

type Executor = Pick<typeof db, 'execute'>;
type Query = ReturnType<typeof sql>;

async function migrationFinished(): Promise<boolean> {
  try {
    return await isBackgroundMigrationDone(ATTACHMENT_OWN_ROWS);
  } catch {
    // Cannot tell (a database that does not answer): act as if it has not.
    return false;
  }
}

/**
 * Gives the descendants of `ownerMessages` (a query of one `id` column: the
 * messages that own the files about to be deleted) their own rows for those
 * files. `except` leaves out messages whose conversation is deleted with them.
 */
export async function giveSharersOwnRows(
  executor: Executor,
  ownerMessages: Query,
  except?: Query,
): Promise<void> {
  if (await migrationFinished()) return;
  const candidates = sql`
    select d.id from message d
    where d.id in (${descendantsOf(ownerMessages)})
    ${except ? sql`and d.thread_id not in (${except})` : sql``}
  `;
  await executor.execute(ownRowsStatement(candidates));
}
