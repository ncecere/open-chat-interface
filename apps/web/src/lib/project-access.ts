import {
  PROJECT_SHARE_ERROR_REASONS,
  type ProjectAccessLevel,
  type ProjectShareErrorReason,
} from '@oci/shared';
import { ApiError, apiErrorMessage } from '~/lib/api-client';

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

const LABELS: Record<ProjectAccessLevel, string> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
};

export function accessLabel(access: ProjectAccessLevel): string {
  return LABELS[access];
}

/** What each level means, for the places that choose or explain one. */
export const ACCESS_SUMMARY: Record<'viewer' | 'editor', string> = {
  viewer: 'Can read the instructions and files and use them in their own conversations.',
  editor: 'Can also change the instructions and add or remove files.',
};

/** The refusal reason the API gave, when it gave a known one (`error.details.reason`). */
export function shareErrorReason(error: unknown): ProjectShareErrorReason | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  return (PROJECT_SHARE_ERROR_REASONS as readonly string[]).includes(reason ?? '')
    ? (reason as ProjectShareErrorReason)
    : undefined;
}

/** How long to wait, in words, for a refusal that said (`Retry-After`). */
export function waitText(seconds: number | undefined): string {
  return seconds
    ? `Try again in ${seconds === 1 ? '1 second' : `${seconds} seconds`}.`
    : 'Wait a moment and try again.';
}

/**
 * What a refused sharing request says. The server's sentences already carry
 * the numbers for a limit and the "upgrade in progress" wording, so they are
 * shown as they are; what is added is a wait for the rate limit, and wording
 * for an unknown address that does not say more than the server did.
 */
export function describeShareError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 429)
      return `Too many sharing attempts. ${waitText(error.retryAfterSeconds)}`;
    const reason = shareErrorReason(error);
    if (reason === 'person_not_found')
      return 'No account has that email address. It has to match exactly.';
    if (reason === 'already_shared')
      return 'This project is already shared with them. Change their access in the list below.';
    if (error.status === 404)
      return 'That person could not be found, or you can no longer share this project.';
  }
  return apiErrorMessage(error, fallback);
}

/** "2 people and 1 group", leaving out what is zero; empty when nothing is shared. Counts only: who they are is never shown. */
export function sharedWithText(personShares: number, groupShares: number): string {
  const people = personShares === 1 ? '1 person' : `${personShares.toLocaleString('en-US')} people`;
  const groups = groupShares === 1 ? '1 group' : `${groupShares.toLocaleString('en-US')} groups`;
  return [personShares > 0 && people, groupShares > 0 && groups].filter(Boolean).join(' and ');
}
