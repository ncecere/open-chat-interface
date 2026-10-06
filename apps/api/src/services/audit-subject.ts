import { or, schema, sql } from '@oci/db';

type SQL = ReturnType<typeof sql.raw>;

const log = schema.auditLog;

/**
 * Audit entries by or about one account: it acted, it was the target, or it
 * is one of the accounts a bulk action named (#216). Bulk actions
 * (`user.bulk.*`) change many accounts in one entry, so they carry no
 * target_id and list the accounts in `metadata.userIds` instead; matching only
 * the actor and target left a bulk role change or sign-out out of the
 * person's trail.
 *
 * Each branch has an index (audit_log_actor_idx, audit_log_target_idx, and
 * the GIN index audit_log_user_ids_idx on `metadata -> 'userIds'`, post-deploy
 * steps 0007 and 0008), so PostgreSQL can combine them instead of scanning
 * the table. The `?` form is the one that GIN index answers.
 */
export function auditEntryAbout(userId: string): SQL {
  return or(
    sql`${log.actorUserId} = ${userId}`,
    sql`${log.targetId} = ${userId}`,
    sql`(${log.metadata} -> 'userIds') ? ${userId}`,
  ) as SQL;
}

/**
 * Entries by or about any account whose email matches `pattern` (an ILIKE
 * pattern), for the audit log's free-text search (#216): the entries done to
 * someone carry their id, not their email, so searching the email found only
 * what they did themselves. The account lookup runs once per query (an
 * uncorrelated subquery PostgreSQL hashes); only bulk entries, which name
 * their accounts in `metadata.userIds`, are unpacked row by row.
 */
export function auditEntryAboutEmail(pattern: string): SQL {
  const accounts = sql`(select ${schema.user.id} from ${schema.user} where ${schema.user.email} ilike ${pattern})`;
  return or(
    sql`${log.actorUserId} in ${accounts}`,
    sql`${log.targetId} in ${accounts}`,
    sql`exists (
      select 1
      from jsonb_array_elements_text(
        case when jsonb_typeof(${log.metadata} -> 'userIds') = 'array'
          then ${log.metadata} -> 'userIds' end
      ) as named(id)
      where named.id in ${accounts}
    )`,
  ) as SQL;
}

/**
 * The email of an entry's actor account, for entries recorded with only its
 * ID (tool calls before #280): the account's current email, or null once it
 * is deleted. Shown in the log in place of the raw ID; the recorded email,
 * when there is one, always comes first.
 */
export const actorAccountEmail = sql<
  string | null
>`(select ${schema.user.email} from ${schema.user} where ${schema.user.id} = ${log.actorUserId})`;
