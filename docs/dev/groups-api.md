# Groups API (v0.14, #394)

For the people building the web screens and project sharing on top of groups. Zod schemas and types are in
`packages/shared/src/schemas/groups.ts` (exported from `@oci/shared`); a response type is the `z.infer` of the
schema named in the response column. All bodies and responses are JSON. Errors have the usual shape
`{ error: { code, message, details? } }`; codes are the existing `ERROR_CODES` (no new code). Where a client needs to
tell refusals of one code apart, `error.details.reason` is one of `GROUP_ERROR_REASONS` (`GroupErrorDetails`).

Not in this document: project shares (`/api/projects/:id/shares`, migration 0054), which belong to project sharing.

## Model in one paragraph

A group has members and managers (`group_member.role`: `member` | `manager`; a manager is also a member for budgets
and models). A person is in any number of groups. Groups only **add**: a model is visible if the person's role is in
`visibleToRoles` OR any of their groups is granted the model; a budget applies if the role OR any group carries it,
all enforced, most restrictive wins, nothing summed. Grants are written only from the group
(`PUT /api/admin/groups/:id/grants`), never through the budget or model forms.

## Limits (`packages/shared`)

| Constant | Value | Refusal |
|---|---|---|
| `MAX_GROUPS` | 500 | 409 `group_limit` on create |
| `MAX_MEMBERS_PER_GROUP` | 5,000 | 409 `member_limit` on add |
| `MAX_MANAGERS_PER_GROUP` | 20 | 409 `manager_limit` on add as manager or promote |
| `MAX_GROUPS_PER_PERSON` | 50 | 409 `person_group_limit`, `details.emails` lists who |
| `MAX_EMAILS_PER_ADD` | 200 | 422 validation (the schema) |
| `MAX_SHARES_PER_PROJECT` / `MAX_INBOUND_SHARES_PER_PERSON` | 50 / 100 | project sharing |
| `PERSON_LOOKUPS_PER_MINUTE` | 30 | 429 (`Retry-After`) on a manager adding by email, one count per request; administrators are not limited |

Limits are checked in the same transaction as the write with the parent row locked; the message states the number.
A request that would break a limit changes nothing.

## Administrator endpoints (`/api/admin/groups`, `requireAdmin`: an auditor may GET, anything else is 403)

| Endpoint | Body or query | Response |
|---|---|---|
| `GET /api/admin/groups` | `?search&page&pageSize` (`listGroupsQuerySchema`; search matches the name) | `AdminGroupsPage` (`groups[]` with `memberCount`, `managerCount`, `policyCount`, `modelCount`) |
| `POST /api/admin/groups` | `{ name, description? }` (`createGroupSchema`) | 201 `AdminGroup`; 409 `name_taken` (ignoring case) or `group_limit` |
| `GET /api/admin/groups/:id` | | `AdminGroupDetail`: the summary plus `grants` (named policies and models, with `enabled`), `createdByName`, `sharedProjectCount` |
| `PATCH /api/admin/groups/:id` | `{ name?, description? }` (at least one; `description: null` or `""` clears) | `AdminGroup`; 409 `name_taken` |
| `DELETE /api/admin/groups/:id` | | `DeleteGroupResult` `{ ok, removed: { members, policies, models, sharedProjects } }`. The dialog reads the same counts from `GET /:id` first |
| `GET /api/admin/groups/:id/members` | `?search&page&pageSize` (matches name or email) | `GroupMembersPage` |
| `POST /api/admin/groups/:id/members` | `{ emails[1..200], role?: 'member' \| 'manager' }` (`addGroupMembersSchema`; addresses are lower-cased and de-duplicated) | `AddGroupMembersResult`: `added`, `alreadyMembers`, `unknown` (every address in exactly one list), `memberCount` |
| `PATCH /api/admin/groups/:id/members/:userId` | `{ role }` | `GroupMember`; 404 when the person is not in the group; 409 `manager_limit` |
| `DELETE /api/admin/groups/:id/members/:userId` | | `{ ok: true }`; 404 when not a member |
| `GET /api/admin/groups/:id/grants` | | `GroupGrants` |
| `PUT /api/admin/groups/:id/grants` | `{ policyIds[], modelIds[] }` (both required; replaces both lists; `putGroupGrantsSchema`) | `GroupGrants`; 422 `unknown_grant` (`details.ids`); 409 `upgrade_in_progress` while an older replica serves |
| `GET /api/admin/groups/:id/usage` | `?days` 1..90, default 30 | `GroupUsage`: usage by the group's **current** members, not a historical label |
| `GET /api/admin/users/:id/groups` | | `{ groups: UserGroup[] }` (the person's groups, for the user detail) |
| `GET /api/admin/users/:id/limits` | (existing) | gains `budgetSources: BudgetSources`: per policy id, `[{ kind: 'role' } \| { kind: 'group', groupId, groupName }]` |
| `GET /api/admin/roles` | (existing) | gains optional `groups: RolesAccessGroup[]` (read-only section) |
| `GET /api/admin/quotas`, `GET /api/admin/models` | (existing) | gain `groups: { id, name }[]` per policy / model: read-only chips. the `POST`, `PUT` and `PATCH` bodies of those routes do not carry groups |

An unknown group id is 404 `Group not found` on every endpoint above.

## Manager and member endpoints (`/api/groups`, any signed-in person)

Who may do what: only **managers of that group** manage its members. A manager sees the member list (name and email)
and adds or removes members; nothing else (no grants, no usage, no roles). An administrator uses the admin endpoints.

How a refusal is chosen (so a response never says whether a group exists to someone who has no business knowing):

| The person | Result on `/api/groups/managed/:id/...` |
|---|---|
| manages the group | allowed |
| is a member (not a manager) of it | 403 |
| manages another group, is not in this one (or the id does not exist) | 403 |
| manages no group at all | 404 |

| Endpoint | Body or query | Response |
|---|---|---|
| `GET /api/groups/mine` | | `{ groups: MyGroup[] }` (every group the person is in; the share dialog's choices); empty for no groups |
| `GET /api/groups/managed` | | `{ groups: ManagedGroup[] }` (empty for a person who manages none; the Settings tab is shown only when `GET /api/me` `settingsSummary.managedGroups > 0`) |
| `GET /api/groups/managed/:id/members` | `?search&page&pageSize` | `GroupMembersPage` |
| `POST /api/groups/managed/:id/members` | `{ emails[1..200] }` (`managerAddGroupMembersSchema`; adds as `member`) | `AddGroupMembersResult` |
| `DELETE /api/groups/managed/:id/members/:userId` | | `{ ok: true }`. A member, or the manager themselves (leaving). Another manager: 403 (an administrator removes managers) |

`GET /api/me` gains `settingsSummary.managedGroups: number` (the number of groups the person manages).

Adding by email is an account-existence oracle for a manager, as sharing by email is for anyone (accepted, rate
limited: `PERSON_LOOKUPS_PER_MINUTE`).

## Audit events (all `group.*` are in `PROTECTED_AUDIT_ACTIONS`)

`group.create`, `group.update` (`changes` as `diffSettings`), `group.delete` (members, grants and shared projects
removed), `group.member.add` and `group.member.remove` (one entry per request listing every account;
`viaManager: boolean`), `group.member.role`, `group.grants.update` (`policyIds` and `modelIds`, before and after).
`targetType` is `group`, `targetId` the group id. Metadata never holds a project name.

## Hooks for project sharing

`apps/api/src/services/groups/membership.ts`: `groupIdsForUser(userId, executor?)` and
`isGroupMember(groupId, userId, executor?)`, uncached.

`apps/api/src/services/groups/access-changes.ts`: `onGroupMembersRemoved(tx, groupId, userIds)`,
`onGroupDeleting(tx, groupId, memberIds)` and `countGroupSharedProjects(tx, groupId)`. The groups code calls them in
the transaction that removes the rows, with the group row locked. They do nothing until project sharing fills them
in (reconcile threads and files there; return the real count of shared projects).

- `onGroupMembersRemoved` runs AFTER the `group_member` rows are deleted (administrator, manager or self-removal),
  so access computed from `group_member` is already the final state.
- `onGroupDeleting` runs BEFORE the group row is deleted, while `project_share` rows naming the group can still be
  read; it may return a function, which the groups code runs in the same transaction AFTER the delete (the cascade
  has then removed the memberships and the shares): reconcile the projects you noted against the access that remains.

`apps/api/src/services/groups/upgrade-guard.ts`: `assertNoOlderReplicas()` (409 `upgrade_in_progress` while a replica
of an earlier minor release serves), for creating a share and changing grants.
