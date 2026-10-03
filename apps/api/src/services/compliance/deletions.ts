import { randomUUID } from 'node:crypto';
import { inArray, schema } from '@oci/db';
import type { db } from '../../db/index.js';
import { getDefaultOrganizationId } from '../organization.js';
import { enqueueWebhookEventsIn } from '../webhooks/delivery.js';

/**
 * Deletion events (v0.10): one audit entry for every conversation, file,
 * project, memory note or account that is moved to the trash, restored or
 * deleted, by a person, an administrator or a background job.
 *
 * They are ordinary audit entries, so the compliance export carries them in
 * its audit stream with the same exactly-once cursor, webhooks can select
 * them, and audit retention treats them like any other entry (keeping them
 * while unexported or while their owner is on legal hold). See
 * docs/dev/v0.10-design.md, "Deletions in the compliance export".
 *
 * Each entry is written in the transaction that makes the change, so a
 * deletion commits if and only if its entry does: there is no deletion
 * without an event and no event for a deletion that rolled back.
 *
 * Entries name what was deleted (type, id, owner) and count what went with
 * it. They never hold what it said: no titles, file names, project names or
 * memory text, because audit entries are shown to administrators, sent to
 * webhooks and kept after the thing itself is gone. Where the compliance
 * export includes content, the ids join to the exported messages (`threadId`,
 * `files[].attachmentId`, `thread.projectId`).
 */

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, 'insert' | 'select'> | Transaction;

export type DeletedObjectType = 'conversation' | 'attachment' | 'project' | 'memory' | 'user';

/** Why it went. Background jobs have no actor; the reason names the job. */
export type DeletionReason =
  /** The owner, from their own conversations, files, projects or memory. */
  | 'user'
  /** An administrator. */
  | 'admin'
  /** The `forget` tool or undoing a saved memory, in the owner's conversation. */
  | 'tool'
  /** Conversation or memory retention. */
  | 'retention'
  /** The trash's retention window elapsed. */
  | 'trash_expiry'
  /** A temporary chat expired. */
  | 'temporary_expiry';

export type DeletionAction =
  | 'conversation.trash'
  | 'conversation.restore'
  | 'conversation.delete'
  | 'attachment.trash'
  | 'attachment.delete'
  | 'project.delete'
  | 'memory.delete'
  | 'user.delete';

/** Every action written by this module, for documentation and tests. */
export const DELETION_ACTIONS: readonly DeletionAction[] = [
  'conversation.trash',
  'conversation.restore',
  'conversation.delete',
  'attachment.trash',
  'attachment.delete',
  'project.delete',
  'memory.delete',
  'user.delete',
];

type Detail = string | number | boolean | null | string[];

export interface DeletionEvent {
  action: DeletionAction;
  /** Null for a background job. */
  actorUserId: string | null;
  /** Looked up from the actor's account when omitted. */
  actorEmail?: string | null;
  id: string;
  ownerUserId: string;
  reason: DeletionReason;
  /** Counts and ids of what went with it, and other non-content facts. */
  details?: Record<string, Detail>;
  /** Kept at the top level of `metadata` for entries that had it before v0.10. */
  legacy?: Record<string, Detail>;
  ipAddress?: string | null;
}

function typeOf(action: DeletionAction): DeletedObjectType {
  return action.slice(0, action.indexOf('.')) as DeletedObjectType;
}

/**
 * Writes one audit entry per event, in the caller's transaction, and queues
 * their webhooks in it too. Throws (failing the deletion) if it cannot.
 */
export async function recordDeletions(tx: Executor, events: DeletionEvent[]): Promise<void> {
  if (events.length === 0) return;
  // Owners and actors by id; an account deleted in this transaction must be
  // looked up before it goes (deleteUser records first, then deletes).
  const ids = [
    ...new Set(
      events.flatMap((event) => [
        event.ownerUserId,
        ...(event.actorUserId && event.actorEmail === undefined ? [event.actorUserId] : []),
      ]),
    ),
  ];
  // Everything through the transaction: a second pooled connection while it
  // holds one could wait forever on a small or exhausted pool.
  const people = await (tx as Transaction)
    .select({
      id: schema.user.id,
      email: schema.user.email,
      organizationId: schema.user.organizationId,
    })
    .from(schema.user)
    .where(inArray(schema.user.id, ids));
  const emailOf = new Map(people.map((person) => [person.id, person.email]));
  const organizationId =
    people.find((person) => person.organizationId)?.organizationId ??
    (await getDefaultOrganizationId());
  const createdAt = new Date();

  const rows = events.map((event) => {
    const type = typeOf(event.action);
    const metadata: Record<string, unknown> = {
      ...event.legacy,
      deletion: {
        type,
        id: event.id,
        ownerUserId: event.ownerUserId,
        ownerEmail: emailOf.get(event.ownerUserId) ?? null,
        reason: event.reason,
        permanent: event.action.endsWith('.delete'),
        ...event.details,
      },
    };
    return {
      id: randomUUID(),
      organizationId,
      actorUserId: event.actorUserId,
      actorEmail:
        event.actorEmail !== undefined
          ? event.actorEmail
          : event.actorUserId
            ? (emailOf.get(event.actorUserId) ?? null)
            : null,
      action: event.action,
      // Memory entries have always named their owner as the target.
      targetType: type === 'memory' ? 'user' : type,
      targetId: type === 'memory' ? event.ownerUserId : event.id,
      metadata,
      ipAddress: event.ipAddress ?? null,
      createdAt,
    };
  });

  // Bounded batches keep a large purge within PostgreSQL's parameter limit.
  for (let start = 0; start < rows.length; start += 500) {
    await (tx as Transaction).insert(schema.auditLog).values(rows.slice(start, start + 500));
  }
  await enqueueWebhookEventsIn(tx as Transaction, rows);
}
