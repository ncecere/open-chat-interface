import type { AccountSharingImpact } from '@oci/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { Spinner } from '~/components/ui/spinner';
import { plural } from '~/lib/utils';

type Subject = 'admin' | 'self';

const be = (count: number) => (count === 1 ? 'is' : 'are');
const s = (count: number) => (count === 1 ? 's' : '');

/**
 * What deleting an account does to other people through project sharing
 * (v0.14), one sentence for each count that is not zero. The same server code
 * runs for an administrator and for the person, so both dialogs say the same
 * thing, worded for who is reading.
 */
export function sharingImpactLines(impact: AccountSharingImpact, subject: Subject): string[] {
  const owns = subject === 'admin' ? 'it owns' : 'you own';
  const added = subject === 'admin' ? 'it added' : 'you added';
  const lines: string[] = [];
  if (impact.sharedProjects > 0)
    lines.push(
      `${plural(impact.sharedProjects, 'shared project')} ${owns} ${be(impact.sharedProjects)} deleted.`,
    );
  if (impact.otherConversations > 0)
    lines.push(
      `${plural(impact.otherConversations, 'conversation')} other people have in those projects ${be(impact.otherConversations)} kept, but leave${s(impact.otherConversations)} the project.`,
    );
  if (impact.othersFiles > 0)
    lines.push(
      `${plural(impact.othersFiles, 'file')} other people added to those projects ${be(impact.othersFiles)} deleted with them.`,
    );
  if (impact.filesHandedToOwners > 0) {
    const one = impact.filesHandedToOwners === 1;
    lines.push(
      `${plural(impact.filesHandedToOwners, 'file')} ${added} to other people's projects ${one ? 'stays' : 'stay'}, and ${one ? 'goes' : 'go'} to the projects' owners.`,
    );
  }
  return lines;
}

/**
 * The impact in a delete-account dialog. The counts are read when the dialog
 * opens; while they load the confirm button waits (the caller reads
 * `isLoading`), and when they cannot be read the dialog says so and the
 * deletion stays possible, as the server applies the same rules either way.
 */
export function SharingImpactNotice({
  query,
  subject,
}: {
  query: Pick<UseQueryResult<AccountSharingImpact>, 'data' | 'isLoading' | 'isError'>;
  subject: Subject;
}) {
  if (query.isLoading) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Spinner /> Checking what this affects…
      </p>
    );
  }
  if (query.isError || !query.data) {
    return (
      <p role="note" className="text-sm text-[var(--text-muted)]">
        Could not check how this affects other people. The deletion works the same either way.
      </p>
    );
  }
  const lines = sharingImpactLines(query.data, subject);
  if (lines.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        {subject === 'admin' ? 'Deleting this account' : 'Deleting your account'} does not affect
        other people’s projects or conversations.
      </p>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm">
      <p className="font-medium">This also affects other people:</p>
      <ul className="mt-1 list-disc ps-5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
