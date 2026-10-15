import { z } from 'zod';

/**
 * Groups (v0.14, #394): sets of people for budgets and model access, with
 * delegated managers who add and remove members. A group only ADDS to what a
 * person's role gives. The endpoints are listed in docs/dev/groups-api.md.
 *
 * The limits are application constants, not settings: they bound the work of
 * one request and one page. Each is enforced in the same transaction as the
 * write, with the parent row locked, and the refusal states the number.
 */
export const MAX_GROUPS = 500;
export const MAX_MEMBERS_PER_GROUP = 5_000;
export const MAX_MANAGERS_PER_GROUP = 20;
export const MAX_GROUPS_PER_PERSON = 50;
/** Email addresses in one "add members" request. */
export const MAX_EMAILS_PER_ADD = 200;
/** Shares on one project; a group counts one (project sharing, same limits file). */
export const MAX_SHARES_PER_PROJECT = 50;
/** Projects shared directly with one person (the sidebar lists at most this many). */
export const MAX_INBOUND_SHARES_PER_PERSON = 100;
/** Email lookups and share writes a person may make a minute (rate-limit buckets `person-lookup`, `project-share`). */
export const PERSON_LOOKUPS_PER_MINUTE = 30;
export const PROJECT_SHARES_PER_MINUTE = 30;

export const GROUP_NAME_MAX_LENGTH = 80;
export const GROUP_DESCRIPTION_MAX_LENGTH = 300;
/** Members listed per page, at most. */
export const GROUP_PAGE_SIZE_MAX = 100;
export const GROUP_PAGE_SIZE_DEFAULT = 50;
/** Longest span the group usage card reads, in days. */
export const GROUP_USAGE_MAX_DAYS = 90;
/** People the group usage card lists. */
export const GROUP_USAGE_MAX_PEOPLE = 100;

export const GROUP_MEMBER_ROLES = ['member', 'manager'] as const;
export type GroupMemberRoleName = (typeof GROUP_MEMBER_ROLES)[number];

/**
 * Why a group request was refused, in `error.details.reason` next to the
 * ordinary error code, so a client can show a field-specific message without
 * reading the sentence. `limit` is the number that was exceeded when the
 * refusal is a limit.
 */
export const GROUP_ERROR_REASONS = {
  /** 409: a group with that name (ignoring case) exists. */
  NAME_TAKEN: 'name_taken',
  /** 409: MAX_GROUPS. */
  GROUP_LIMIT: 'group_limit',
  /** 409: MAX_MEMBERS_PER_GROUP. */
  MEMBER_LIMIT: 'member_limit',
  /** 409: MAX_MANAGERS_PER_GROUP. */
  MANAGER_LIMIT: 'manager_limit',
  /** 409: MAX_GROUPS_PER_PERSON; `details.emails` names who. */
  PERSON_GROUP_LIMIT: 'person_group_limit',
  /** 409: a replica older than this release is still serving; try again when the upgrade has finished. */
  UPGRADE_IN_PROGRESS: 'upgrade_in_progress',
  /** 422: a grant names a budget or model that does not exist; `details.ids` lists them. */
  UNKNOWN_GRANT: 'unknown_grant',
} as const;
export type GroupErrorReason = (typeof GROUP_ERROR_REASONS)[keyof typeof GROUP_ERROR_REASONS];

/** What a client finds in `error.details` for the refusals above. */
export interface GroupErrorDetails {
  reason: GroupErrorReason;
  limit?: number;
  emails?: string[];
  ids?: string[];
}

export const MESSAGE_UPGRADE_IN_PROGRESS = 'An upgrade is still in progress';

const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the group a name.')
  .max(GROUP_NAME_MAX_LENGTH, `Group names can be at most ${GROUP_NAME_MAX_LENGTH} characters.`);

const groupDescriptionSchema = z
  .string()
  .trim()
  .max(
    GROUP_DESCRIPTION_MAX_LENGTH,
    `Descriptions can be at most ${GROUP_DESCRIPTION_MAX_LENGTH} characters.`,
  );

export const groupMemberRoleSchema = z.enum(GROUP_MEMBER_ROLES);

/**
 * A group named on a budget or model, as a read-only chip (`groups` on the
 * responses of `GET /api/admin/quotas` and `GET /api/admin/models`). Never part
 * of those routes' request bodies: grants are written from the group.
 */
export const groupRefSchema = z.object({ id: z.string(), name: z.string() });
export type GroupRef = z.infer<typeof groupRefSchema>;

/** Addresses are compared case-insensitively; duplicates in one request count once. */
const emailsSchema = z
  .array(z.string().trim().toLowerCase().email('Enter valid email addresses.').max(320))
  .min(1, 'Enter at least one email address.')
  .max(MAX_EMAILS_PER_ADD, `Add at most ${MAX_EMAILS_PER_ADD} email addresses at a time.`)
  .transform((emails) => [...new Set(emails)]);

const pageSchema = z.coerce.number().int().min(1).max(100_000).default(1);
const pageSizeSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(GROUP_PAGE_SIZE_MAX)
  .default(GROUP_PAGE_SIZE_DEFAULT);

// ---- Requests ------------------------------------------------------------

/** `GET /api/admin/groups` */
export const listGroupsQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  page: pageSchema,
  pageSize: pageSizeSchema,
});

/** `GET /api/admin/groups/:id/members` and `GET /api/groups/managed/:id/members` */
export const listGroupMembersQuerySchema = z.object({
  /** Matches name or email, ignoring case. */
  search: z.string().trim().max(320).optional(),
  page: pageSchema,
  pageSize: pageSizeSchema,
});

/** `POST /api/admin/groups` */
export const createGroupSchema = z
  .object({
    name: groupNameSchema,
    description: groupDescriptionSchema.nullable().optional(),
  })
  .strict();

/** `PATCH /api/admin/groups/:id`; send at least one field. An empty description clears it. */
export const updateGroupSchema = z
  .object({
    name: groupNameSchema.optional(),
    description: groupDescriptionSchema.nullable().optional(),
  })
  .strict();

/** `POST /api/admin/groups/:id/members` */
export const addGroupMembersSchema = z
  .object({
    emails: emailsSchema,
    role: groupMemberRoleSchema.default('member'),
  })
  .strict();

/** `POST /api/groups/managed/:id/members`: a manager adds members only. */
export const managerAddGroupMembersSchema = z.object({ emails: emailsSchema }).strict();

/** `PATCH /api/admin/groups/:id/members/:userId` */
export const updateGroupMemberSchema = z.object({ role: groupMemberRoleSchema }).strict();

/**
 * `PUT /api/admin/groups/:id/grants`: replaces both lists. Both are required,
 * so a client that omits one cannot silently clear it (the reason grants are
 * written from the group and never through the budget or model forms).
 */
export const putGroupGrantsSchema = z
  .object({
    policyIds: z
      .array(z.string().min(1).max(64))
      .max(500)
      .transform((ids) => [...new Set(ids)]),
    modelIds: z
      .array(z.string().min(1).max(64))
      .max(1000)
      .transform((ids) => [...new Set(ids)]),
  })
  .strict();

/** `GET /api/admin/groups/:id/usage` */
export const groupUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(GROUP_USAGE_MAX_DAYS).default(30),
});

// ---- Responses -----------------------------------------------------------

/** One row of the administrator's list, and the head of the detail. */
export const adminGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Members including managers. */
  memberCount: z.number().int().nonnegative(),
  managerCount: z.number().int().nonnegative(),
  /** Budgets the group carries. */
  policyCount: z.number().int().nonnegative(),
  /** Models the group makes visible. */
  modelCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const adminGroupsPageSchema = z.object({
  groups: z.array(adminGroupSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  /** Groups matching the search, across all pages. */
  total: z.number().int().nonnegative(),
  /** MAX_GROUPS, so the page can say how many may still be created. */
  limit: z.number().int().positive(),
});

/** What a group grants, named for the checklists. Administrators and auditors only. */
export const groupGrantsSchema = z.object({
  policies: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
  models: z.array(
    z.object({ id: z.string(), slug: z.string(), displayName: z.string(), enabled: z.boolean() }),
  ),
});

export const adminGroupDetailSchema = adminGroupSchema.extend({
  grants: groupGrantsSchema,
  createdByName: z.string().nullable(),
  /**
   * People who would lose access when the group is deleted, for the delete
   * dialog: projects shared with the group (zero until project sharing is
   * present) and the members, which are in `memberCount`.
   */
  sharedProjectCount: z.number().int().nonnegative(),
});

export const groupMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: groupMemberRoleSchema,
  addedAt: z.string(),
});

export const groupMembersPageSchema = z.object({
  members: z.array(groupMemberSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});

/** `POST …/members`: every address lands in exactly one list. */
export const addGroupMembersResultSchema = z.object({
  added: z.array(z.object({ userId: z.string(), email: z.string(), role: groupMemberRoleSchema })),
  /** Already in the group (a manager asked to be added as a member stays a manager). */
  alreadyMembers: z.array(z.string()),
  /** No account has this address. */
  unknown: z.array(z.string()),
  memberCount: z.number().int().nonnegative(),
});

/** `DELETE /api/admin/groups/:id` */
export const deleteGroupResultSchema = z.object({
  ok: z.literal(true),
  removed: z.object({
    members: z.number().int().nonnegative(),
    policies: z.number().int().nonnegative(),
    models: z.number().int().nonnegative(),
    sharedProjects: z.number().int().nonnegative(),
  }),
});

/** `GET /api/groups/managed`: a group the signed-in person manages. No grants, no usage. */
export const managedGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().nonnegative(),
  managerCount: z.number().int().nonnegative(),
  /** The most members the group may have, so the page can say how much room is left. */
  memberLimit: z.number().int().positive(),
});

/** `GET /api/groups/mine`: a group the signed-in person is in (the share dialog). */
export const myGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: groupMemberRoleSchema,
});

/** `GET /api/admin/groups/:id/usage`: usage by the group's current members, as of now. */
export const groupUsageSchema = z.object({
  days: z.number().int().positive(),
  since: z.string(),
  memberCount: z.number().int().nonnegative(),
  totals: z.object({
    messages: z.number().nonnegative(),
    tokensIn: z.number().nonnegative(),
    tokensOut: z.number().nonnegative(),
    costMicros: z.number().nonnegative(),
  }),
  /** The busiest people, at most GROUP_USAGE_MAX_PEOPLE, by cost then messages. */
  people: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      email: z.string(),
      messages: z.number().nonnegative(),
      tokensIn: z.number().nonnegative(),
      tokensOut: z.number().nonnegative(),
      costMicros: z.number().nonnegative(),
    }),
  ),
  /** True when members beyond the listed people also have usage. */
  truncated: z.boolean(),
});

/**
 * The Groups section of Roles & access (`GET /api/admin/roles`, optional
 * `groups`), read-only.
 */
export const rolesAccessGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  memberCount: z.number().int().nonnegative(),
  managerCount: z.number().int().nonnegative(),
  budgets: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
  models: z.array(z.object({ id: z.string(), displayName: z.string(), enabled: z.boolean() })),
});

/** Where a person's budget comes from, in `GET /api/admin/users/:id/limits`. */
export const BUDGET_SOURCES = ['role', 'group'] as const;
export const budgetSourceSchema = z.object({
  /** `role` for a budget the person's role carries; `group` for one a group they are in carries. */
  kind: z.enum(BUDGET_SOURCES),
  /** The group's id and name when `kind` is `group`. */
  groupId: z.string().optional(),
  groupName: z.string().optional(),
});

/**
 * Added to `GET /api/admin/users/:id/limits` as `budgetSources`: for each budget
 * (by policy id) in the person's allowances, every way it reaches them. A
 * budget the role and a group both carry lists both and is still enforced once.
 */
export const budgetSourcesSchema = z.record(z.string(), z.array(budgetSourceSchema));

/** The person's groups in `GET /api/admin/users/:id/groups`. */
export const userGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: groupMemberRoleSchema,
});

export type AdminGroup = z.infer<typeof adminGroupSchema>;
export type AdminGroupsPage = z.infer<typeof adminGroupsPageSchema>;
export type AdminGroupDetail = z.infer<typeof adminGroupDetailSchema>;
export type GroupGrants = z.infer<typeof groupGrantsSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type GroupMembersPage = z.infer<typeof groupMembersPageSchema>;
export type AddGroupMembersResult = z.infer<typeof addGroupMembersResultSchema>;
export type DeleteGroupResult = z.infer<typeof deleteGroupResultSchema>;
export type ManagedGroup = z.infer<typeof managedGroupSchema>;
export type MyGroup = z.infer<typeof myGroupSchema>;
export type GroupUsage = z.infer<typeof groupUsageSchema>;
export type RolesAccessGroup = z.infer<typeof rolesAccessGroupSchema>;
export type BudgetSource = z.infer<typeof budgetSourceSchema>;
export type BudgetSources = z.infer<typeof budgetSourcesSchema>;
export type UserGroup = z.infer<typeof userGroupSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type AddGroupMembersInput = z.infer<typeof addGroupMembersSchema>;
export type PutGroupGrantsInput = z.infer<typeof putGroupGrantsSchema>;
