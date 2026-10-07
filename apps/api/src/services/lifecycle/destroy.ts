import { inArray, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { giveSharersOwnRows } from '../attachments/shared-rows.js';
import { type DeletionReason, recordDeletions } from '../compliance/deletions.js';

/**
 * Permanent deletion of conversations and trashed files, with one deletion
 * event per row in the same transaction (services/compliance/deletions.ts).
 *
 * Every caller passes a condition that already excludes people on legal hold
 * (`notOnLegalHold`) or has refused the request for them; this module only
 * makes sure what is deleted is also recorded.
 */

const BATCH_SIZE = 500;

/** A condition built with `and(...)`; never empty (that would match every row). */
type Condition = ReturnType<typeof sql.raw> | undefined;

function required(where: Condition): ReturnType<typeof sql.raw> {
  if (!where) throw new Error('A deletion needs a condition');
  return where;
}

type Victim = {
  id: string;
  userId: string;
  temporary: boolean;
  projectId: string | null;
  messages: number;
  attachments: number;
  artifacts: number;
};

/**
 * Deletes the conversations matching `where` (a condition on `thread`), with
 * their messages, files and artifacts (by cascade), recording one
 * `conversation.delete` per conversation that counts what went with it.
 *
 * Background jobs pass `skipLocked` so a conversation someone is using is left
 * for the next run; a person's own request waits instead. Returns the ids
 * deleted.
 */
export async function destroyThreads(
  condition: Condition,
  options: {
    reason: DeletionReason;
    actorUserId: string | null;
    skipLocked?: boolean;
    /** Repeats in batches until nothing matches (background jobs). */
    all?: boolean;
  },
): Promise<string[]> {
  const where = required(condition);
  const deleted: string[] = [];
  for (;;) {
    const batch = await db.transaction(async (tx) => {
      const victims = await tx.execute<Victim>(sql`
        select ${schema.thread.id} as id, ${schema.thread.userId} as "userId",
          ${schema.thread.temporary} as temporary, ${schema.thread.projectId} as "projectId",
          (select count(*) from "message" as "doomed_message"
            where "doomed_message"."thread_id" = ${schema.thread.id})::int as messages,
          (select count(*) from "attachment" as "doomed_file"
            inner join "message" as "file_message" on "file_message"."id" = "doomed_file"."message_id"
            where "file_message"."thread_id" = ${schema.thread.id})::int as attachments,
          (select count(*) from "artifact" as "doomed_artifact"
            where "doomed_artifact"."thread_id" = ${schema.thread.id})::int as artifacts
        from ${schema.thread}
        where ${where}
        order by ${schema.thread.id}
        limit ${BATCH_SIZE}
        for update of ${schema.thread}${options.skipLocked ? sql` skip locked` : sql``}
      `);
      if (victims.length === 0) return [];
      // A fork or edit made before 0.11 may still share a file with what is
      // deleted here: it gets its own row first (#358; a no-op once the
      // background migration has finished). The messages to follow are those
      // that own a file and those that only show one (a fork of a fork whose
      // middle conversation goes first would otherwise lose the link).
      const doomed = sql.join(
        victims.map((victim) => sql`${victim.id}`),
        sql`, `,
      );
      await giveSharersOwnRows(
        tx,
        sql`select m.id from message m where m.thread_id in (${doomed})
            and m.role = 'user' and jsonb_typeof(m.parts) = 'array'
            and m.parts @> '[{"type": "data-attachment"}]'::jsonb
          union
          select a.message_id from attachment a
            join message m on m.id = a.message_id where m.thread_id in (${doomed})`,
        doomed,
      );
      const gone = await tx
        .delete(schema.thread)
        .where(
          inArray(
            schema.thread.id,
            victims.map((victim) => victim.id),
          ),
        )
        .returning({ id: schema.thread.id });
      const goneIds = new Set(gone.map((row) => row.id));
      await recordDeletions(
        tx,
        victims
          .filter((victim) => goneIds.has(victim.id))
          .map((victim) => ({
            action: 'conversation.delete' as const,
            actorUserId: options.actorUserId,
            id: victim.id,
            ownerUserId: victim.userId,
            reason: options.reason,
            details: {
              temporary: victim.temporary,
              projectId: victim.projectId,
              messages: Number(victim.messages),
              attachments: Number(victim.attachments),
              artifacts: Number(victim.artifacts),
            },
          })),
      );
      return [...goneIds];
    });
    deleted.push(...batch);
    if (!options.all || batch.length < BATCH_SIZE) return deleted;
  }
}

type FileVictim = {
  id: string;
  userId: string;
  messageId: string | null;
  threadId: string | null;
  projectId: string | null;
  sizeBytes: number;
};

/**
 * Deletes the files matching `where` (a condition on `attachment`) that are
 * not part of a conversation being deleted with them, recording one
 * `attachment.delete` each. The delete trigger releases their storage and
 * queues the stored objects for the storage reaper.
 */
export async function destroyAttachments(
  condition: Condition,
  options: {
    reason: DeletionReason;
    actorUserId: string | null;
    skipLocked?: boolean;
    all?: boolean;
  },
): Promise<FileVictim[]> {
  const where = required(condition);
  const deleted: FileVictim[] = [];
  for (;;) {
    const batch = await destroyAttachmentBatch(where, options);
    deleted.push(...batch);
    if (!options.all || batch.length < BATCH_SIZE) return deleted;
  }
}

async function destroyAttachmentBatch(
  where: ReturnType<typeof sql.raw>,
  options: { reason: DeletionReason; actorUserId: string | null; skipLocked?: boolean },
): Promise<FileVictim[]> {
  return db.transaction(async (tx) => {
    const victims = await tx.execute<FileVictim>(sql`
      select ${schema.attachment.id} as id, ${schema.attachment.userId} as "userId",
        ${schema.attachment.messageId} as "messageId", ${schema.attachment.projectId} as "projectId",
        ${schema.attachment.sizeBytes} as "sizeBytes",
        (select "file_message"."thread_id" from "message" as "file_message"
          where "file_message"."id" = ${schema.attachment.messageId}) as "threadId"
      from ${schema.attachment}
      where ${where}
      order by ${schema.attachment.id}
      limit ${BATCH_SIZE}
      for update of ${schema.attachment}${options.skipLocked ? sql` skip locked` : sql``}
    `);
    if (victims.length === 0) return [];
    // As for conversations: whatever still shares one of these files gets its
    // own row first (#358).
    await giveSharersOwnRows(
      tx,
      sql`select message_id from attachment where message_id is not null and id in (${sql.join(
        victims.map((victim) => sql`${victim.id}`),
        sql`, `,
      )})`,
    );
    const gone = await tx
      .delete(schema.attachment)
      .where(
        inArray(
          schema.attachment.id,
          victims.map((victim) => victim.id),
        ),
      )
      .returning({ id: schema.attachment.id });
    const goneIds = new Set(gone.map((row) => row.id));
    const removed = victims.filter((victim) => goneIds.has(victim.id));
    await recordDeletions(
      tx,
      removed.map((victim) => ({
        action: 'attachment.delete' as const,
        actorUserId: options.actorUserId,
        id: victim.id,
        ownerUserId: victim.userId,
        reason: options.reason,
        details: {
          threadId: victim.threadId,
          messageId: victim.messageId,
          projectId: victim.projectId,
          sizeBytes: Number(victim.sizeBytes),
        },
      })),
    );
    return removed;
  });
}
