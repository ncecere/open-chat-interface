import {
  MAX_DIRECT_INBOUND_SHARES_PER_USER,
  MAX_PROJECTS_PER_USER,
  MAX_SHARES_PER_PROJECT,
  PROJECT_SHARE_ERROR_REASONS,
  type ProjectAccessLevel,
  type ProjectShareErrorReason,
} from '@oci/shared';
import { ApiError, apiErrorMessage } from '~/lib/api-client';
import { formatList, type MessageKey, translate } from '~/lib/i18n';

/**
 * What each access level may do on the project page (SPEC-groups.md, access
 * matrix). The server is the boundary and refuses the rest with 403 or 404;
 * this only decides what the page does not offer, so nobody is invited to try
 * what would be refused.
 */
export interface ProjectControls {
  /** Change the project's name. */
  rename: boolean;
  /** Change the instructions. */
  editInstructions: boolean;
  /** Upload files and remove any file. */
  manageFiles: boolean;
  /** Add, change and remove shares. */
  share: boolean;
  /** Give the project to someone else. */
  transfer: boolean;
  /** Delete the project. */
  remove: boolean;
  /** Remove one's own direct share (a share through a group needs the group's manager). */
  leave: boolean;
}

const CONTROLS: Record<ProjectAccessLevel, ProjectControls> = {
  owner: {
    rename: true,
    editInstructions: true,
    manageFiles: true,
    share: true,
    transfer: true,
    remove: true,
    leave: false,
  },
  editor: {
    rename: false,
    editInstructions: true,
    manageFiles: true,
    share: false,
    transfer: false,
    remove: false,
    leave: true,
  },
  viewer: {
    rename: false,
    editInstructions: false,
    manageFiles: false,
    share: false,
    transfer: false,
    remove: false,
    leave: true,
  },
};

export function projectControls(access: ProjectAccessLevel): ProjectControls {
  return CONTROLS[access];
}

/** An older API sent only the caller's own projects and no `access`, so absent reads as owner. */
export function accessOf(project: { access?: ProjectAccessLevel }): ProjectAccessLevel {
  return project.access ?? 'owner';
}

const LABEL_KEYS: Record<ProjectAccessLevel, MessageKey> = {
  owner: 'sharing.permission.owner',
  editor: 'sharing.permission.editor',
  viewer: 'sharing.permission.viewer',
};

/** The name of an access level: the same word in every list, chip and sentence that shows one. */
export function accessLabel(access: ProjectAccessLevel): string {
  return translate(LABEL_KEYS[access]);
}

/** What each level means, for the places that choose or explain one. */
export function accessSummary(level: 'viewer' | 'editor'): string {
  return translate(
    level === 'viewer' ? 'sharing.permission.viewerSummary' : 'sharing.permission.editorSummary',
  );
}

/** The refusal reason the API gave, when it gave a known one (`error.details.reason`). */
export function shareErrorReason(error: unknown): ProjectShareErrorReason | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  return (PROJECT_SHARE_ERROR_REASONS as readonly string[]).includes(reason ?? '')
    ? (reason as ProjectShareErrorReason)
    : undefined;
}

/** Where a sharing request came from: the same refusal reads differently to whoever is acting. */
export type ShareErrorContext = 'share' | 'transfer';

/**
 * The sentence for each reason the API gives, so a refusal reads in the
 * person's language whatever language the server wrote it in. The server's
 * numbers are the shared constants it uses.
 */
function reasonText(reason: ProjectShareErrorReason, context: ShareErrorContext): string {
  switch (reason) {
    case 'upgrade_in_progress':
      return translate('sharing.error.upgradeInProgress');
    case 'already_shared':
      return translate('sharing.error.alreadyShared');
    case 'share_limit':
      return translate('sharing.error.shareLimit', { limit: MAX_SHARES_PER_PROJECT });
    case 'inbound_limit':
      return translate(
        context === 'transfer' ? 'sharing.error.inboundLimitYou' : 'sharing.error.inboundLimit',
        { limit: MAX_DIRECT_INBOUND_SHARES_PER_USER },
      );
    case 'person_not_found':
      return translate('sharing.error.personNotFound');
    case 'cannot_share_with_self':
      return translate('sharing.error.cannotShareWithSelf');
    case 'not_a_group_member':
      return translate('sharing.error.notAGroupMember');
    case 'leave_via_group':
      return translate('sharing.error.leaveViaGroup');
    case 'transfer_target_not_editor':
      return translate('sharing.error.transferTargetNotEditor');
    case 'transfer_target_project_limit':
      return translate('sharing.error.transferTargetProjectLimit', {
        limit: MAX_PROJECTS_PER_USER,
      });
    case 'transfer_target_projects_off':
      return translate('sharing.error.transferTargetProjectsOff');
    case 'legal_hold':
      return translate('sharing.error.legalHold');
  }
}

/**
 * What a refused sharing request says, by the reason the API gave (`error.details.reason`),
 * so every known refusal is a complete sentence in the person's language. A wait for
 * the rate limit is added; a refusal with no known reason shows the server's own text.
 */
export function describeShareError(
  error: unknown,
  fallback: string,
  context: ShareErrorContext = 'share',
): string {
  if (error instanceof ApiError) {
    if (error.status === 429)
      return error.retryAfterSeconds
        ? translate('sharing.error.rateLimitedWait', { count: error.retryAfterSeconds })
        : translate('sharing.error.rateLimited');
    const reason = shareErrorReason(error);
    if (reason) return reasonText(reason, context);
    if (error.status === 404) return translate('sharing.error.notFound');
  }
  return apiErrorMessage(error, fallback);
}

/** "2 people and 1 group", leaving out what is zero; empty when nothing is shared. Counts only: who they are is never shown. */
export function sharedWithText(personShares: number, groupShares: number): string {
  return formatList([
    ...(personShares > 0 ? [translate('sharing.summary.people', { count: personShares })] : []),
    ...(groupShares > 0 ? [translate('sharing.summary.groups', { count: groupShares })] : []),
  ]);
}
