import { createHash } from 'node:crypto';
import { and, asc, gt, lte, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import { summarizeMessageParts } from './content.js';

const PAGE = 500;

export interface StreamTotals {
  count: number;
  bytes: number;
  firstSeq: number | null;
  lastSeq: number | null;
  firstId: string | null;
  lastId: string | null;
  hash: ReturnType<typeof createHash>;
}

export const newTotals = (): StreamTotals => ({
  count: 0,
  bytes: 0,
  firstSeq: null,
  lastSeq: null,
  firstId: null,
  lastId: null,
  hash: createHash('sha256'),
});

function encodeLines(
  rows: Array<{ seq: number; id: string; line: Record<string, unknown> }>,
  totals: StreamTotals,
): Uint8Array {
  const body = Buffer.from(rows.map((row) => `${JSON.stringify(row.line)}\n`).join(''), 'utf8');
  for (const row of rows) {
    totals.count += 1;
    totals.firstSeq ??= row.seq;
    totals.firstId ??= row.id;
    totals.lastSeq = row.seq;
    totals.lastId = row.id;
  }
  totals.bytes += body.byteLength;
  totals.hash.update(body);
  return body;
}

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

/** One line per audit entry with a sequence number in (after, through], in order. */
export async function* auditLines(
  after: number,
  through: number,
  totals: StreamTotals,
): AsyncGenerator<Uint8Array> {
  let cursor = after;
  while (cursor < through) {
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(and(gt(schema.auditLog.seq, cursor), lte(schema.auditLog.seq, through)))
      .orderBy(asc(schema.auditLog.seq))
      .limit(PAGE);
    if (rows.length === 0) return;
    cursor = Number(rows.at(-1)!.seq);
    yield encodeLines(
      rows.map((row) => ({
        seq: Number(row.seq),
        id: row.id,
        line: {
          seq: Number(row.seq),
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          action: row.action,
          actorUserId: row.actorUserId,
          actorEmail: row.actorEmail,
          targetType: row.targetType,
          targetId: row.targetId,
          metadata: row.metadata ?? null,
          ipAddress: row.ipAddress,
        },
      })),
      totals,
    );
  }
}

interface MessageRow extends Record<string, unknown> {
  seq: string | number;
  id: string;
  thread_id: string;
  user_id: string;
  user_email: string | null;
  role: string;
  parts: unknown;
  status: string;
  model_slug: string | null;
  parent_message_id: string | null;
  superseded_at: Date | string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  thread_title: string;
  thread_temporary: boolean;
  thread_project_id: string | null;
}

/**
 * One line per message whose change sequence number is in (after, through].
 * A message still streaming is skipped: finishing it changes its status and
 * gives it a new number, so it is exported once, complete.
 */
export async function* messageLines(
  after: number,
  through: number,
  totals: StreamTotals,
): AsyncGenerator<Uint8Array> {
  let cursor = after;
  while (cursor < through) {
    const rows = await db.execute<MessageRow>(sql`
      select m.change_seq as seq, m.id, m.thread_id, m.user_id, u.email as user_email,
        m.role, m.parts, m.status, m.model_slug, m.parent_message_id, m.superseded_at,
        m.error_message, m.created_at, m.updated_at,
        t.title as thread_title, t.temporary as thread_temporary, t.project_id as thread_project_id
      from ${schema.message} m
      join ${schema.thread} t on t.id = m.thread_id
      left join ${schema.user} u on u.id = m.user_id
      where m.change_seq > ${cursor} and m.change_seq <= ${through}
      order by m.change_seq
      limit ${PAGE}
    `);
    if (rows.length === 0) return;
    cursor = Number(rows.at(-1)!.seq);
    const complete = rows.filter((row) => row.status !== 'streaming');
    if (complete.length === 0) continue;
    yield encodeLines(
      complete.map((row) => {
        const content = summarizeMessageParts(row.parts);
        return {
          seq: Number(row.seq),
          id: row.id,
          line: {
            seq: Number(row.seq),
            id: row.id,
            threadId: row.thread_id,
            userId: row.user_id,
            userEmail: row.user_email,
            role: row.role,
            status: row.status,
            model: row.model_slug,
            parentMessageId: row.parent_message_id,
            createdAt: iso(row.created_at),
            updatedAt: iso(row.updated_at),
            supersededAt: iso(row.superseded_at),
            error: row.error_message,
            thread: {
              title: row.thread_title,
              temporary: row.thread_temporary,
              projectId: row.thread_project_id,
            },
            ...content,
          },
        };
      }),
      totals,
    );
  }
}

export interface StreamPlan {
  after: number;
  through: number;
}

export function streamSummary(plan: StreamPlan, key: string | null, totals: StreamTotals) {
  return {
    key,
    afterSeq: plan.after,
    throughSeq: plan.through,
    count: totals.count,
    firstSeq: totals.firstSeq,
    lastSeq: totals.lastSeq,
    firstId: totals.firstId,
    lastId: totals.lastId,
    bytes: totals.bytes,
    sha256: key ? totals.hash.copy().digest('hex') : null,
  };
}
