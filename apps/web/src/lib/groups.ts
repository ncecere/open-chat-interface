import {
  type AddGroupMembersResult,
  GROUP_ERROR_REASONS,
  type GroupErrorDetails,
  type GroupErrorReason,
  MICROS_PER_DOLLAR,
} from '@oci/shared';
import { ApiError, apiErrorMessage } from '~/lib/api-client';
import { formatList, translate } from '~/lib/i18n';
import { isolate } from '~/lib/projects-text';
import { plural } from '~/lib/utils';

/** Every administrator query about groups; invalidating it refreshes the list, a page and its members. */
export const ADMIN_GROUPS_KEY = ['admin', 'groups'] as const;
/** One group's detail and everything under it (its members, usage). */
export function groupDetailKey(groupId: string) {
  return [...ADMIN_GROUPS_KEY, 'detail', groupId] as const;
}
/** The groups a manager manages (Settings → Groups). */
export const MANAGED_GROUPS_KEY = ['groups', 'managed'] as const;

/** The names the group forms use for the API's field names, so an error says what the form says. */
export const GROUP_FIELD_LABELS = {
  name: 'Name',
  description: 'Description',
  emails: 'Email addresses',
};

/** The refusal reason the API gave, when it gave one (`error.details.reason`). */
export function groupErrorReason(error: unknown): GroupErrorReason | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const reason = (error.details as Partial<GroupErrorDetails> | undefined)?.reason;
  return Object.values(GROUP_ERROR_REASONS).includes(reason as GroupErrorReason)
    ? (reason as GroupErrorReason)
    : undefined;
}

/** How long to wait, in words, for a refusal that said (`Retry-After`). */
function waitText(seconds: number | undefined): string {
  return seconds ? `Try again in ${plural(seconds, 'second')}.` : 'Wait a moment and try again.';
}

/**
 * What a failed group request says. The server's sentences already state the
 * number for a limit; what is added is who is affected (a person already in
 * the most groups they may be in), how long to wait after too many lookups,
 * and plain wording for a group that has gone.
 */
export function describeGroupError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return `Too many email lookups. ${waitText(error.retryAfterSeconds)}`;
    if (error.status === 404) return 'This group could not be found. It may have been deleted.';
    const details = error.details as Partial<GroupErrorDetails> | undefined;
    if (groupErrorReason(error) === GROUP_ERROR_REASONS.UNKNOWN_GRANT)
      return 'A budget or model you chose no longer exists. Close this page, open it again and choose from the current lists.';
    if (
      groupErrorReason(error) === GROUP_ERROR_REASONS.PERSON_GROUP_LIMIT &&
      details?.emails?.length
    ) {
      return `${error.message} Not added: ${details.emails.join(', ')}.`;
    }
  }
  return apiErrorMessage(error, fallback, GROUP_FIELD_LABELS);
}

/** Email addresses typed or pasted, one per line or separated by commas, semicolons or spaces. */
export function parseEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface AddOutcome {
  /** One sentence for the status line. */
  summary: string;
  /** Addresses that were not added, with why, for a list under it. */
  problems: Array<{ label: string; emails: string[] }>;
}

/** What an add did, in words: every address is in exactly one list of the result. */
export function describeAddResult(result: AddGroupMembersResult): AddOutcome {
  const added = result.added.length;
  const summary =
    added === 0
      ? translate('groups.add.nobodyAdded')
      : translate('groups.add.added', { added, members: result.memberCount });
  const problems = [
    { label: translate('groups.add.alreadyMembers'), emails: result.alreadyMembers },
    { label: translate('groups.add.unknown'), emails: result.unknown },
  ].filter((entry) => entry.emails.length > 0);
  return { summary, problems };
}

/** Dollars for an amount in micro-dollars. */
export function formatCost(micros: number): string {
  const dollars = micros / MICROS_PER_DOLLAR;
  return `$${dollars.toFixed(dollars > 0 && dollars < 0.01 ? 4 : 2)}`;
}

/** "1 member", "3 members"; the one word the group counts are read in. */
export function memberCountText(count: number): string {
  return plural(count, 'member');
}

/**
 * What a failed request on a manager's Settings page says, in the person's
 * language: a group that has gone, or that the person no longer manages, in
 * their words; the person lookup limit with its wait (`Retry-After` is in
 * seconds); and the limits and the upgrade wait by the reason the API gave.
 * Anything else shows the server's own sentence, or the caller's fallback.
 * (The administrator's pages stay in English: they use `describeGroupError`.)
 */
export function describeManagerError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 429)
      return error.retryAfterSeconds
        ? translate('groups.error.tooManyLookupsWait', { count: error.retryAfterSeconds })
        : translate('groups.error.tooManyLookups');
    if (error.status === 404) return translate('groups.error.noLongerManager');
    if (error.status === 403) return translate('groups.error.notManager');
    const details = error.details as Partial<GroupErrorDetails> | undefined;
    switch (groupErrorReason(error)) {
      case GROUP_ERROR_REASONS.UPGRADE_IN_PROGRESS:
        return translate('groups.error.upgradeInProgress');
      case GROUP_ERROR_REASONS.MEMBER_LIMIT:
        if (details?.limit) return translate('groups.error.memberLimit', { limit: details.limit });
        break;
      case GROUP_ERROR_REASONS.PERSON_GROUP_LIMIT:
        if (details?.limit && details.emails?.length)
          return translate('groups.error.personGroupLimit', {
            limit: details.limit,
            emails: formatList(details.emails.map(isolate)),
          });
        break;
    }
  }
  return apiErrorMessage(error, fallback, GROUP_FIELD_LABELS);
}
