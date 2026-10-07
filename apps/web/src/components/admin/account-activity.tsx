import type { AuditLogEntry } from '@oci/shared';
import { useCurrentUser } from '~/hooks/use-current-user';
import { formatRelativeTime } from '~/lib/utils';

/** What the account page's Recent activity needs of an audit entry. */
export type AccountActivityEntry = Pick<
  AuditLogEntry,
  | 'id'
  | 'action'
  | 'actorUserId'
  | 'actorEmail'
  | 'targetType'
  | 'targetId'
  | 'ipAddress'
  | 'createdAt'
> & { metadata?: AuditLogEntry['metadata'] };

/** The other account an entry names: by the email it records (#323), else its ID. */
function otherAccount(entry: AccountActivityEntry): string {
  const email = entry.metadata?.email;
  return typeof email === 'string' && email ? email : (entry.targetId ?? 'another account');
}

/**
 * Who did what to whom, in words (#324). The trail lists the account's
 * entries as actor, as target and among the accounts a bulk action named, but
 * each row showed only its action and time: "user.update" could be this person
 * banning someone or being banned. A row now says which.
 */
export function activityParties(
  entry: AccountActivityEntry,
  account: { id: string; name: string },
  viewerId: string | undefined,
): string {
  if (entry.actorUserId === account.id) {
    const onOther = entry.targetType === 'user' && entry.targetId && entry.targetId !== account.id;
    return onOther ? `By ${account.name}, to ${otherAccount(entry)}` : `By ${account.name}`;
  }
  const actor =
    entry.actorUserId && entry.actorUserId === viewerId
      ? 'you'
      : (entry.actorEmail ?? entry.actorUserId ?? 'the system');
  return `To ${account.name}, by ${actor}`;
}

export function AccountActivityList({
  entries,
  account,
}: {
  entries: AccountActivityEntry[];
  account: { id: string; name: string };
}) {
  const viewerId = useCurrentUser().data?.user.id;
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <code className="rounded bg-[var(--bg-control-alt)] px-1.5 py-0.5 text-xs">
            {entry.action}
          </code>
          {/* Wraps rather than cutting off an email without a tooltip (#195, #244). */}
          <span className="min-w-0 break-words text-[var(--text-secondary)] text-xs [overflow-wrap:anywhere]">
            {activityParties(entry, account, viewerId)}
          </span>
          {entry.ipAddress && (
            <span className="font-mono text-[var(--text-muted)] text-xs">{entry.ipAddress}</span>
          )}
          <span className="ml-auto shrink-0 text-[var(--text-muted)] text-xs">
            {formatRelativeTime(entry.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
