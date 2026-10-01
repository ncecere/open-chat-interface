import { sql } from '@oci/db';
import { db } from '../../db/index.js';

export interface StorageSummary {
  liveBytes: number;
  liveFileCount: number;
  pendingBytes: number;
  pendingFileCount: number;
  topUsers: Array<{ userId: string; name: string; email: string; bytes: number; files: number }>;
  /** How many people hold storage, behind the capped list above. */
  totalUsers: number;
}

/** Where object storage is actually going. */
export async function storageSummary(): Promise<StorageSummary> {
  const [totals] = await db.execute<{
    live_bytes: string;
    live_files: string;
    pending_bytes: string;
    pending_files: string;
  }>(sql`
    select
      coalesce(sum(size_bytes) filter (where deleted_at is null), 0) as live_bytes,
      count(*) filter (where deleted_at is null) as live_files,
      coalesce(sum(size_bytes) filter (where deleted_at is not null), 0) as pending_bytes,
      count(*) filter (where deleted_at is not null) as pending_files
    from attachment
  `);

  const topUsers = await db.execute<{
    user_id: string;
    name: string;
    email: string;
    bytes: string;
    files: string;
  }>(sql`
    select a.user_id, u.name, u.email,
           coalesce(sum(a.size_bytes), 0) as bytes,
           count(*) as files
    from attachment a
    join "user" u on u.id = a.user_id
    where a.deleted_at is null
    group by a.user_id, u.name, u.email
    order by sum(a.size_bytes) desc
    limit 10
  `);

  const [countedUsers] = await db.execute<{ total: string }>(sql`
    select count(distinct user_id) as total from attachment where deleted_at is null
  `);

  return {
    totalUsers: Number(countedUsers?.total ?? 0),
    liveBytes: Number(totals?.live_bytes ?? 0),
    liveFileCount: Number(totals?.live_files ?? 0),
    pendingBytes: Number(totals?.pending_bytes ?? 0),
    pendingFileCount: Number(totals?.pending_files ?? 0),
    topUsers: topUsers.map((row) => ({
      userId: row.user_id,
      name: row.name,
      email: row.email,
      bytes: Number(row.bytes),
      files: Number(row.files),
    })),
  };
}
