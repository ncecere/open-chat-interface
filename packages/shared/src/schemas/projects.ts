import { z } from 'zod';
import { attachmentSchema, threadSummarySchema } from './chat.js';

/**
 * Projects group conversations under shared instructions and files.
 *
 * The limits are application constants rather than settings: they bound how
 * much a single project can add to every turn's context and how many rows a
 * sidebar has to render, not how much storage someone may use (storage
 * allowances already cover that).
 */
export const PROJECT_NAME_MAX_LENGTH = 100;
export const PROJECT_INSTRUCTIONS_MAX_LENGTH = 8000;
export const MAX_PROJECTS_PER_USER = 100;
export const MAX_FILES_PER_PROJECT = 20;
/** Shares on one project; a group counts one (v0.14, #394). */
export const MAX_SHARES_PER_PROJECT = 50;
/** Projects other people have shared directly with one person; the sidebar lists at most this many. */
export const MAX_DIRECT_INBOUND_SHARES_PER_USER = 100;
/** Fixed per-person limit on exact-email lookups and share writes, per minute (v0.14). */
export const PROJECT_SHARE_RATE_LIMIT_PER_MINUTE = 30;
/** Recent conversations the sidebar lists under each project (v0.9.1). */
export const SIDEBAR_PROJECT_THREAD_LIMIT = 5;

const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the project a name.')
  .max(
    PROJECT_NAME_MAX_LENGTH,
    `Project names can be at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
  );

const projectInstructionsSchema = z
  .string()
  .max(
    PROJECT_INSTRUCTIONS_MAX_LENGTH,
    `Instructions can be at most ${PROJECT_INSTRUCTIONS_MAX_LENGTH} characters.`,
  );

export const createProjectSchema = z
  .object({
    name: projectNameSchema,
    instructions: projectInstructionsSchema.default(''),
  })
  .strict();

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    instructions: projectInstructionsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Send at least one change.' });

/**
 * What a person may do with a project (v0.14, #394). `owner` also renames,
 * deletes, shares, reshares and transfers; `editor` also edits instructions and
 * adds or removes files; `viewer` reads and uses the project in their own
 * conversations. A person with no access gets 404, never 403.
 */
export const PROJECT_ACCESS_LEVELS = ['owner', 'editor', 'viewer'] as const;
export const projectAccessLevelSchema = z.enum(PROJECT_ACCESS_LEVELS);
export type ProjectAccessLevel = z.infer<typeof projectAccessLevelSchema>;

/** The permissions a share can grant; ownership moves only by transfer. */
export const PROJECT_SHARE_PERMISSIONS = ['viewer', 'editor'] as const;
export const projectSharePermissionSchema = z.enum(PROJECT_SHARE_PERMISSIONS);
export type ProjectSharePermission = z.infer<typeof projectSharePermissionSchema>;

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  instructions: z.string(),
  /** Ready files; uploads still in progress are not counted. */
  fileCount: z.number().int().nonnegative(),
  /** Live conversations (not archived, trashed or temporary). */
  threadCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * The caller's access (v0.14). Always sent by v0.14; absent from an older API,
   * which only ever returned the caller's own projects, so absent reads as `owner`.
   */
  access: projectAccessLevelSchema.optional(),
  /** The owner's display name. Present when the project is shared with the caller; never an email. */
  ownerName: z.string().optional(),
});

/**
 * One project in the sidebar's tree (`GET /api/projects/sidebar`, v0.9.1).
 * `recentThreads` are the newest live conversations that are not pinned, at
 * most SIDEBAR_PROJECT_THREAD_LIMIT, newest first: pinned ones are listed
 * only in the sidebar's Pinned section. `threadCount` counts every live
 * conversation in the project, pinned ones included.
 */
export const sidebarProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  threadCount: z.number().int().nonnegative(),
  recentThreads: z.array(threadSummarySchema),
  /** v0.14: as on ProjectSummary. `threadCount` and `recentThreads` are always the caller's own conversations. */
  access: projectAccessLevelSchema.optional(),
  ownerName: z.string().optional(),
});

/**
 * Whether a project file can be searched when a project is too large to give
 * the model whole. `pending` files are waiting for the background indexing
 * job and are used whole meanwhile, as far as they fit; `no-text` files (such
 * as images) have nothing to search and are always used whole.
 */
export const projectFileIndexSchema = z.object({
  status: z.enum(['indexed', 'pending', 'no-text']),
  /** Searchable passages the file was split into. */
  passages: z.number().int().nonnegative(),
  /**
   * The file was longer than one file's passage limit, so only its start is
   * searchable. Absent from an older API, which reads as false.
   */
  truncated: z.boolean().optional(),
});

/** A project file is an attachment owned by the project rather than a message. */
export const projectFileSchema = attachmentSchema.extend({
  index: projectFileIndexSchema,
  /**
   * v0.14: the display name of the person who added the file (null once their
   * account is gone). Never an email.
   */
  addedBy: z.string().nullable().optional(),
  /** v0.14: the caller added this file. */
  addedByMe: z.boolean().optional(),
});

/** Characters of a passage kept in a reply's project-search note (v0.10). */
export const PROJECT_EXCERPT_MAX_CHARS = 200;
/** Passages listed in one reply's project-search note (v0.10); the rest are only counted. */
export const PROJECT_EXCERPTS_MAX = 24;

const projectSearchExcerptSchema = z.object({
  /** Stable within the reply: the file's id and the passage numbers. */
  id: z.string().max(300),
  /** 1-based passage numbers of the first and last chunk, as the model saw them. */
  first: z.number().int().positive(),
  last: z.number().int().positive(),
  heading: z.string().max(200).optional(),
  /** Ends with an ellipsis when the passage was longer. */
  snippet: z.string().max(PROJECT_EXCERPT_MAX_CHARS + 1),
});

/**
 * The `data-project-search` part on a reply whose project files were too large
 * to include whole, so passages were chosen instead. It names the files used
 * and how many passages came from each. Since v0.10 each file also lists its
 * passages (`excerpts`): an id, the passage numbers, the nearest heading when
 * the passage has one, and only the first PROJECT_EXCERPT_MAX_CHARS characters
 * of its text, at most PROJECT_EXCERPTS_MAX per reply; older replies have no
 * excerpts. `excluded` (v0.10) names the files the person left out of this
 * message; with exclusions and no searched passages, `files` is empty.
 * The part is never shown on shared links. `mode` is `search` when passages
 * matched the message.
 * `opening` is only on replies stored before v0.9's relevance floors, when
 * nothing matched and each file's opening passages were used; now a reply
 * that used no passages has no part at all.
 * `ranking` (v0.9) says how searched passages were ranked: `hybrid` when
 * meaning-based (vector) results were merged with keyword results, `keyword`
 * otherwise. Absent on replies from before v0.9, which were keyword-only.
 * `reranked` (v0.9) is present only when a reranking model is configured:
 * `true` when it reordered the candidates, `false` when it could not and the
 * previous order was used.
 * `withheld` (v0.14, data classification) names the outside services this
 * reply did not use because the conversation carries a class they are not
 * approved for: meaning-based search (`embeddings`, keyword search only) and
 * `reranking` (the combined order kept).
 */
export const projectSearchDataSchema = z.object({
  mode: z.enum(['search', 'opening']),
  ranking: z.enum(['hybrid', 'keyword']).optional(),
  reranked: z.boolean().optional(),
  withheld: z.array(z.enum(['embeddings', 'reranking'])).optional(),
  files: z.array(
    z.object({
      name: z.string(),
      passages: z.number().int().positive(),
      excerpts: z.array(projectSearchExcerptSchema).max(PROJECT_EXCERPTS_MAX).optional(),
    }),
  ),
  excluded: z
    .array(z.object({ name: z.string() }))
    .max(MAX_FILES_PER_PROJECT)
    .optional(),
});

/** `GET /api/projects`: `projects` stays the caller's own; `shared` is new in v0.14, so an older web bundle never mistakes a shared project for its own. */
export const projectListSchema = z.object({
  projects: z.array(projectSummarySchema),
  shared: z.array(projectSummarySchema),
});

/** `GET /api/projects/sidebar`: as above. `shared` is at most MAX_DIRECT_INBOUND_SHARES_PER_USER plus group shares, capped at the same number. */
export const sidebarProjectListSchema = z.object({
  projects: z.array(sidebarProjectSchema),
  shared: z.array(sidebarProjectSchema),
});

/** Who a share names. A person is found by exact email; a group must be one the owner belongs to. */
export const shareSubjectInputSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('person'),
      email: z.string().trim().toLowerCase().email().max(320),
    })
    .strict(),
  z.object({ type: z.literal('group'), groupId: z.string().min(1).max(200) }).strict(),
]);

export const createProjectShareSchema = z
  .object({ subject: shareSubjectInputSchema, permission: projectSharePermissionSchema })
  .strict();

export const updateProjectShareSchema = z
  .object({ permission: projectSharePermissionSchema })
  .strict();

/** The target must already hold a direct editor share. */
export const transferProjectSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(320) })
  .strict();

/** A share as the owner sees it (`GET /api/projects/:id/shares`). Other people never get this. */
export const projectShareSchema = z.object({
  id: z.string(),
  permission: projectSharePermissionSchema,
  subject: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('person'),
      userId: z.string(),
      name: z.string(),
      email: z.string(),
    }),
    z.object({
      type: z.literal('group'),
      groupId: z.string(),
      name: z.string(),
      memberCount: z.number().int().nonnegative(),
    }),
  ]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * `GET /api/projects/:id/access` (any access): what the caller may do and the
 * share list as counts only. A group counts one share, as for the limit.
 */
export const projectAccessInfoSchema = z.object({
  access: projectAccessLevelSchema,
  ownerName: z.string(),
  /** People the project is shared with directly. */
  personShares: z.number().int().nonnegative(),
  /** Groups the project is shared with. */
  groupShares: z.number().int().nonnegative(),
  /** The caller holds a direct share they can leave (`POST /:id/leave`); false for the owner and for access only through a group. */
  canLeave: z.boolean(),
});

/**
 * Why a sharing request was refused, in `error.details.reason` next to the
 * code (409 CONFLICT, 422 VALIDATION_FAILED or 429 RATE_LIMITED). The message
 * is always a sentence for people; clients branch on the reason.
 */
export const PROJECT_SHARE_ERROR_REASONS = [
  /** 409: a replica of the previous release is still serving; creating shares waits for the upgrade to finish. */
  'upgrade_in_progress',
  /** 409: the project is already shared with that person or group (change it with PATCH). */
  'already_shared',
  /** 422: MAX_SHARES_PER_PROJECT reached. */
  'share_limit',
  /** 422: the person already has MAX_DIRECT_INBOUND_SHARES_PER_USER projects shared with them. */
  'inbound_limit',
  /** 422: no account has that email (an exact match is required). */
  'person_not_found',
  /** 422: the owner cannot share with themselves. */
  'cannot_share_with_self',
  /** 422: a group must be one the owner belongs to. */
  'not_a_group_member',
  /** 409: access comes only through a group; ask a group manager. */
  'leave_via_group',
  /** 422: transfer needs a direct editor share first. */
  'transfer_target_not_editor',
  /** 422: the new owner already has MAX_PROJECTS_PER_USER projects. */
  'transfer_target_project_limit',
  /** 422: the new owner's role does not allow projects. */
  'transfer_target_projects_off',
  /** 409: legal hold on the actor or on the person who added a file (the existing hold message). */
  'legal_hold',
] as const;
export type ProjectShareErrorReason = (typeof PROJECT_SHARE_ERROR_REASONS)[number];

/**
 * Audit actions for sharing (v0.14). They name the project id, the subject and
 * the permission, never the project's name or content. Not protected.
 */
export const PROJECT_SHARE_AUDIT_ACTIONS = [
  'project.share.create',
  'project.share.update',
  'project.share.delete',
  'project.transfer',
  'project.access.revoked',
] as const;

/**
 * `GET /api/admin/users/:id/sharing-impact` and `GET /api/me/sharing-impact`
 * (v0.14): what deleting the account does to other people, for the
 * confirmation dialogs. Counts only.
 */
export const accountSharingImpactSchema = z.object({
  /** Projects the account owns that are shared with someone. */
  sharedProjects: z.number().int().nonnegative(),
  /** Other people's conversations in the account's projects: kept, but they leave the project. */
  otherConversations: z.number().int().nonnegative(),
  /** Files other people added to the account's projects: deleted with them. */
  othersFiles: z.number().int().nonnegative(),
  /** Finished files the account added to other people's projects: handed to those owners. */
  filesHandedToOwners: z.number().int().nonnegative(),
});
export type AccountSharingImpact = z.infer<typeof accountSharingImpactSchema>;

export type ProjectShare = z.infer<typeof projectShareSchema>;
export type ProjectAccessInfo = z.infer<typeof projectAccessInfoSchema>;
export type CreateProjectShareInput = z.infer<typeof createProjectShareSchema>;
export type UpdateProjectShareInput = z.infer<typeof updateProjectShareSchema>;
export type TransferProjectInput = z.infer<typeof transferProjectSchema>;
export type ProjectList = z.infer<typeof projectListSchema>;
export type SidebarProjectList = z.infer<typeof sidebarProjectListSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type SidebarProject = z.infer<typeof sidebarProjectSchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectFileIndex = z.infer<typeof projectFileIndexSchema>;
export type ProjectSearchData = z.infer<typeof projectSearchDataSchema>;
