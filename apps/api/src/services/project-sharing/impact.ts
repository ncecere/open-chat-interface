import { sql } from '@oci/db';
import type { AccountSharingImpact } from '@oci/shared';
import { db } from '../../db/index.js';

/**
 * What deleting an account would do to other people through sharing (v0.14), for
 * the confirmation dialogs (administrator and self-service): the projects it owns
 * that are shared, other people's conversations in them (kept, but they leave the
 * project), files other people added to its projects (deleted with them), and
 * files it added to others' projects (handed to those owners). Counts only.
 */
export async function accountSharingImpact(userId: string): Promise<AccountSharingImpact> {
  const [row] = await db.execute<Record<string, number>>(sql`
    select
      (select count(*) from "project" as "p"
        where "p"."user_id" = ${userId}
          and exists (select 1 from "project_share" as "ps" where "ps"."project_id" = "p"."id"))::int as "sharedProjects",
      (select count(*) from "thread" as "t"
        join "project" as "p" on "p"."id" = "t"."project_id"
        where "p"."user_id" = ${userId} and "t"."user_id" <> ${userId})::int as "otherConversations",
      (select count(*) from "attachment" as "a"
        join "project" as "p" on "p"."id" = "a"."project_id"
        where "p"."user_id" = ${userId} and "a"."user_id" <> ${userId})::int as "othersFiles",
      (select count(*) from "attachment" as "a"
        join "project" as "p" on "p"."id" = "a"."project_id"
        where "a"."user_id" = ${userId} and "p"."user_id" <> ${userId}
          and "a"."upload_pending" = false)::int as "filesHandedToOwners"
  `);
  return {
    sharedProjects: Number(row?.sharedProjects ?? 0),
    otherConversations: Number(row?.otherConversations ?? 0),
    othersFiles: Number(row?.othersFiles ?? 0),
    filesHandedToOwners: Number(row?.filesHandedToOwners ?? 0),
  };
}
