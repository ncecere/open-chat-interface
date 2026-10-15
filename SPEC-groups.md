# Spec: groups

Module of [SPEC.md](SPEC.md) (v0.14). Depends on nothing. Shared commands, structure, style, testing and
boundaries are in SPEC.md; this file adds what is specific to this module. Status: **draft for review**
(written 2026-10-14 against `main` at v0.13.1; nothing was run to write it, see "Not verified").

## Objective

Give a department its own limits and models, let the people who know who belongs manage membership
(delegated managers), and let a person share a project with colleagues without sharing conversations. Closes the
groups half of #394; custom roles are out of v0.14 (SPEC.md decision 1) and move to a new issue. Shared projects
follow SPEC.md decision 4.

**Approach:**

1. **Groups overlay the role.** The four roles stay a closed list. A group has members and managers; a person is
   in any number of groups. Groups only **add** (model visibility, budgets); nothing a group does removes an access
   the role gives. A group grants budgets and extra models, nothing else (not storage, rate limits, features).
2. **Projects are shared** with a person or a group as `viewer` or `editor` (`project_share`). Access is computed per
   request from `project`, `project_share` and `group_member`; never cached, never copied onto threads or files.
3. **One function decides project access** and one SQL fragment mirrors it for raw queries. A unit test lists every
   file that reads project data, so a new query cannot skip the question (the pattern of
   `legal-hold-paths.unit.test.ts`).

## Today (v0.13.1), verified

- **Budgets.** `quota_policy_role` joins a policy to a role (`packages/db/src/schema/usage.ts:125`).
  `loadPoliciesForRole(role, userId)` (`services/quota/index.ts:44-90`) loads the role's enabled policies and
  applies per-person overrides (`:97-120`); `reserveQuotaForRun` keeps those covering the model (`:160-161`).
  `reserveQuota` (`quota/reservation.ts`) checks **each** policy against the person's own usage and refuses when
  **any** is spent; reserved estimates are clamped to the smallest remaining allowance. `docs/admin/governance.md`
  ("Usage budgets") says so: several budgets per role, every one enforced, each person gets the full amount.
- **Models.** `model.visibleToRoles` (`schema/provider.ts:55`) is filtered at `services/models.ts:47`
  (`listAvailableModels`) and `:117` (`resolveModelForRole`). Callers pass only the role: `routes/me.ts:129,240`,
  `routes/models.ts:12`, `chat/turn-context.ts:41`, `chat/approvals.ts:113`, `chat/compaction-queue.ts:382`,
  `chat/compaction-records.ts:90`, `routes/threads.ts:370`.
- **Projects** are owner-scoped throughout. Threads point at a project (`thread.project_id`, `SET NULL`); files are
  `attachment` rows with `project_id` (cascade) and `user_id` = uploader, so storage is already counted per
  uploader (`storage/usage.ts:28,66`). Project instructions and files are model-only context built every turn; only
  the reply's `data-project-search` note (file names, counts, the first ~200 characters of each passage) is stored
  (`chat/stream-response.ts:244`).
- Admin access is by role name and method (`requireAdmin`, `middleware/context.ts:118`: auditors GET only);
  `auth/permissions.ts` statements are declarative. **`docs/admin/roles-and-access.md` does not exist**: Roles &
  access lives in `docs/admin/governance.md#roles-and-access`, built by `getRolesAccess()` (`roles-access.ts:30`).

## Data model

Two pre-deploy migrations: new tables only, no `ALTER` of an existing table, no backfill, no post-deploy step or
background migration, no `releases.json` `requires`. Hand-written with journal entries (snapshots stopped at 0042).
Every foreign key is `ON DELETE CASCADE` (`SET NULL` for "created by"), **never `RESTRICT`**, so a v0.13 replica
deleting a user, model, policy or project is never blocked by rows it cannot see. `group` is a reserved word: raw
SQL must quote it (a slip fails loudly).

**0053_groups** (`packages/db/src/schema/groups.ts`)

| Table | Columns and constraints |
|---|---|
| `group` | `id`, `organization_id`, `name` (check 1..80), `description` null (<= 300), `created_by_user_id`, timestamps; unique `(organization_id, lower(name))` |
| `group_member` | `group_id`, `user_id`, `role` check in (`member`,`manager`) default `member`, `added_by_user_id`, `created_at`; PK `(group_id, user_id)`; index `(user_id)`. A manager is also a member for budgets and models. |
| `quota_policy_group` | `id`, `policy_id`, `group_id`, `created_at`; unique `(policy_id, group_id)`; index `(group_id)` (mirrors `quota_policy_role`) |
| `model_group_access` | `id`, `model_id`, `group_id`, `created_at`; unique `(model_id, group_id)`; index `(group_id)` |

**0054_project_shares**: `project_share`: `id`, `project_id`, `subject_type` check in (`person`,`group`),
`subject_user_id` null, `subject_group_id` null, `permission` check in (`viewer`,`editor`), `created_by_user_id`,
timestamps. A check requires exactly the column matching `subject_type`. Partial unique indexes
`(project_id, subject_user_id)` and `(project_id, subject_group_id)`; partial indexes on each subject column for
"shared with me".

The linter accepts all of it (tables created in the same file are new; a plain `CREATE INDEX` on one is fine). It
checks `idx` against journal position, not the tag number (`scripts/lint-migrations/folders.mjs:13`), so on this
branch the entries are `idx` 50 and 51 with tags `0053_…` and `0054_…`; the integrator renumbers `idx` and gives
`when` values above the other modules' (0046-0049 step by one: `1790539200026..29`).

**Invariants** (tests enforce them):

- **I-1** Every project file is owned by the project owner or by someone who currently has editor access;
  unfinished uploads stay with their uploader until they complete.
- **I-2** A person's thread points at a project only if they have access. Reads re-check anyway, so a missed repair
  leaks nothing.
- **I-3** No answer about shares or membership is cached across requests.

## Access rules

`projectAccess(executor, projectId, userId)` returns `owner | editor | viewer | null`: owner if
`project.user_id = userId`, else the highest permission among shares naming the person or any group in
`group_member` for them. Its raw-SQL twin `projectReadableBy(projectId, userId)` (an `EXISTS`, evaluated once per
statement) replaces `a.user_id = …` in raw queries; a test compares the two. `null` answers 404 `Project not
found`, as today (existence never leaks); too little permission with access answers 403. Two gates stay first: the
role's `projects` switch (`assertProjectsAllowed`, `projects.ts:37`) and, for files, the `attachments` switches. A
`restricted` person (projects off by default) simply sees nothing.

**viewer** reads name, instructions and files and uses them in their own conversations. **editor** also edits
instructions, uploads and removes files. **owner** also renames, deletes, shares, reshares, transfers. Direct and
group grants combine by taking the highest.

### Access matrix

✓ allowed; 403 has access, lacks permission; 404 as if the project did not exist. "Via group" is the same
permission reached through a group share (the tests run all four). Every column also needs the `projects` switch.

| Action | Owner | Editor | Viewer | Via group (editor) | Via group (viewer) | Outsider | Admin | Auditor |
|---|---|---|---|---|---|---|---|---|
| In own list and sidebar ("Shared with me") | ✓ | ✓ | ✓ | ✓ | ✓ | absent | absent | absent |
| Read name and instructions | ✓ | ✓ | ✓ | ✓ | ✓ | 404 | 404 | 404 |
| List files; download a file | ✓ | ✓ | ✓ | ✓ | ✓ | 404 | 404 | 404 |
| Use in an own conversation (context, keyword and meaning search, rerank, headings) | ✓ | ✓ | ✓ | ✓ | ✓ | none | none | none |
| Start or move an own conversation into it; list own conversations in it | ✓ | ✓ | ✓ | ✓ | ✓ | 404 | 404 | 404 |
| Read another person's conversation in it | never | never | never | never | never | never | never | never |
| Rename | ✓ | 403 | 403 | 403 | 403 | 404 | 404 | 404 |
| Edit instructions | ✓ | ✓ | 403 | ✓ | 403 | 404 | 404 | 404 |
| Upload a file (uploader's role, rate limit, storage) | ✓ | ✓ | 403 | ✓ | 403 | 404 | 404 | 404 |
| Remove any file | ✓ | ✓ | 403 | ✓ | 403 | 404 | 404 | 404 |
| Delete; add, change or remove a share; transfer | ✓ | 403 | 403 | 403 | 403 | 404 | 404 | 404 |
| See the share list | names | counts | counts | counts | counts | 404 | 404 | 404 |
| Leave (remove own direct share) | - | ✓ | ✓ | 409 | 409 | 404 | 404 | 404 |
| In the personal data export | all files | files they added | nothing | files they added | nothing | - | - | - |

An administrator and an auditor are outsiders to project content, as today ("titles only", `docs/admin/people.md`);
they manage groups. Threads are `thread.user_id`-scoped (`threads.ts:192,272,307,398`) and stay so: nobody reads
another person's conversation. Non-owners see the owner's display name, counts of the share list, and per file who
added it; never the people list or emails. Viewers may download files (they could ask the model to recite them).

## Every query that scopes by owner or reads project data

**A** becomes access-aware; **O** stays owner-only on purpose; **S** system job with no actor; **U** unchanged and
correct. Lines are v0.13.1.

| # | Where | Today | Becomes |
|---|---|---|---|
| 1 | `projects.ts:117` `listProjects` | owned | **U**; new `listSharedProjects`. `/api/projects` keeps `projects` = owned and adds `shared`, so an older web bundle never mistakes a shared project for its own |
| 2 | `projects.ts:53-60` `threadCountSql`, `:141-190` `listSidebarProjects` | owner's projects; threads of `project.user_id` | **A**: owned + shared; counts and recent threads are the **viewer's own** |
| 3 | `projects.ts:195` `getOwnedProject` (callers `routes/projects.ts:120`, `routes/threads.ts:139`, `projects.ts:321`), `:205` `getProjectSummary` | owner or 404 | `getOwnedProject` kept for **O** operations; new `requireProjectAccess(id, user, min)`; summary adds `access`, `ownerName` |
| 4 | `projects.ts:254` `updateProject` | owner | **A**: editor changes `instructions` only |
| 5 | `projects.ts:277` `deleteProject` (`:286`, files `:298`) | owner; owner's hold | **O**, plus refused when any file was added by someone on legal hold |
| 6 | `projects.ts:320` `listProjectFiles` (`:340`) | files by `user_id` | **A**: all files of the project; adds `addedBy` |
| 7 | `projects.ts:356` + `attachments/upload.ts:80-91` | project lock `where user_id = uploader`; 20-file count | **A**: access checked under the same `FOR UPDATE`; quota, role limits and the cap unchanged, charged to the uploader |
| 8 | `projects.ts:393` `deleteProjectFile` (`:403,:413`) | owner's file in owner's project | **A**: editor or owner removes any file; refused under the actor's or the uploader's hold |
| 9 | `projects.ts:437` `moveThreadToProject` (`:449`), `threads.ts:222-255` `createThread` (`:254`), `routes/threads.ts:137-144` | owner's project | **A**: any access level; the thread stays the actor's (`:459`) |
| 10 | `threads.ts:175-215` `listThreads`; `:307,:398` fork and edit copy `projectId` | `thread.user_id` | **U** (private by construction); fork and edit copy `projectId` only while access holds |
| 11 | `chat/project-context.ts:76-102` `loadProjectContext` (`:87,:94`), `:111-131` (`:126`), `:135-152` (`:147`), `:192`, `:323`, `:387` | owner; `ProjectContext.userId` (`:41`) | **A**: resolve access first; none means an ordinary conversation (as with the switch off); `userId` becomes the **actor**, plus `ownerId` |
| 12 | `chat/attachment-context.ts:116-134` `inspectProjectFiles` (`:126`) | owner's files | **A** |
| 13 | `chat/attachment-context.ts:137-153` `materializeAttachments` (`:153`), called with message and project files together at `chat/model-context.ts:311` | `user_id` = person for all | **A**, **the likeliest break**: a shared file has another uploader, so every turn would fail "Attachment context changed". Project candidates use a second, project-scoped query; message files stay **O** (`:97-100`, `:215`) |
| 14 | `project-search/retrieval.ts:114-132` `scopedChunks` (`:127`); `:221` `indexedChunkCounts` | `a.user_id` and project; ids from the scoped list | **A**: `projectReadableBy`; `indexedChunkCounts` **U** (ids already scoped; a test proves it) |
| 15 | `vector-store/pgvector-sql.ts:66-82` `scopeFilter` (`:81`), `project-search/semantic.ts:52,101`, `excerpts.ts:99` `passageHeadings` | `a.user_id = personId` | **A**: `personId` becomes `actorId`, checked by `projectReadableBy`; still throws `VectorScopeError` when missing |
| 16 | `semantic.ts:103-111`, `rerank.ts:45,85`; `pgvector.ts:363-392`; `indexing.ts:36-110`, `embedding.ts` | usage to the asker or the passage's owner; jobs by attachment id | **U** / **S**: the asker pays for questions, the uploader for passages; `deleteByProject`/`deleteByPerson` (`:486,:496`) are keyed by attachment |
| 17 | `attachments/index.ts:21-34` `getOwnedAttachment` (route `/:id/content`) | `user_id` = person | **A**: own file, or a live project file the person can read |
| 18 | `attachments/index.ts:50-72,:95-107`; `storage/usage.ts:28,:57-70`; `storage/quota.ts:92` | by uploader | **U**: this is "files count against the uploader" |
| 19 | `lifecycle/destroy.ts:60,:169-198`, `trash.ts`, `retention.ts:122-128` | threads and files by owner or age; longest budget window | **U**: a viewer's conversations die as before and never touch the project; project files have no trash; group budgets are already in the window |
| 20 | `portability/export-archive.ts:145-156,:447-452` | owner's projects, files by `user_id` | **A**: the owner's export includes every file of their projects; a person's export adds `shared-projects/<name>/` with only the files they added |
| 21 | `admin-users/mutations.ts:274-348` `deleteUser` (and self-service `account-deletion.ts`, which calls it) | cascade | **A**: see Lifecycle |
| 22 | `compliance/export-lines.ts:103,122,157`; `share-links.ts`; `embeddings/status.ts:50`; `routes/admin/health.ts:150`; `usage-report/storage.ts`; `backups/*` | project id only / none / instance-wide | **U**: no project content is exported or shared today |

`project-data-paths.unit.test.ts` scans `apps/api/src` for `schema.project`, `schema.attachment` with
`projectId`/`project_id`, `project_file_chunk` and `project_file_embedding*`, and fails unless each file is listed
here with A, O, S or U and a reason.

## Group rules

**Budgets.** A person's policies are the **distinct** enabled policies attached to their role **or** to any of their
groups (deduplicated by policy id). Each is then treated exactly as today: kept if it covers the model, overridden
if the person has an override, checked independently, refused if any is spent. **Most restrictive wins; nothing is
summed**, as for a role carrying several budgets. So (docs say so): a group budget never raises a limit above a role
budget covering the same models (use a per-person override, now allowed on group budgets); budgets are **per
person**, not a pool; people outside every group are unaffected. Change `loadPoliciesForRole` (`quota/index.ts:44`)
to union `quota_policy_role` for the role with `quota_policy_group` for the person's groups; `policiesForUser`
(`policy-queries.ts:75`) and `override-admin.ts:26,87` include them (their rule "a policy the role carries" becomes
"the role or a group carries"). People never see group or budget names (#93); the admin limits view
(`GET /api/admin/users/:id/limits`) names the source.

**Models.** Visible if the role is in `visibleToRoles` **or** any of the person's groups is in
`model_group_access`; a disabled model or provider stays unavailable. `listAvailableModels` and
`resolveModelForRole` (`models.ts:37,105`) take `{ userId, role }`; all seven callers pass the user. One extra
indexed lookup per call (`group_member` by `user_id`); removal takes effect on the next request.

**Who may do what.**

| | Admin | Auditor | Manager of that group | Member |
|---|---|---|---|---|
| Create, rename, delete a group; appoint or remove a manager | ✓ | read | - | - |
| Add or remove members | ✓ | read | members only; may remove themselves | - |
| See the member list (name, email) | ✓ | ✓ | ✓ | - |
| See or change what a group grants; see usage | ✓ | read | - | - |

Grants are written **only from the group** (`PUT /api/admin/groups/:id/grants`), never through the budget or model
forms: the budget schema is `.strict()` and `roles` defaults to `[]` on `PUT` (`schemas/admin.ts:305-325`), so a
`groupIds` field there would be wiped by any client that omits it. Budget and model pages show groups as read-only
chips.

**Limits** (`packages/shared/src/schemas/groups.ts`; counted in the same transaction with the parent row locked;
errors state the number): 500 groups; 5,000 members and 20 managers per group; 50 groups per person; 200 emails
per add; 50 shares per project (a group counts one); 100 direct inbound shares per person (the sidebar lists at
most 100 shared projects). Email lookups and share writes: `consumeRateLimit` (`services/limits/rate-limit.ts:62`)
buckets `person-lookup` and `project-share`, 30 a minute per person, fixed constants.

## Endpoints

New routes need no read-only allowance (writes are refused in maintenance by default;
`read-only-allowlist.unit.test.ts` must stay green).

- **Admin** (`routes/admin/groups.ts`, `requireAdmin`; auditor GET): `GET /api/admin/groups?search&page` (counts);
  `POST`, `PATCH /:id`, `DELETE /:id` (the dialog counts shares and members that go); `GET /:id/members`;
  `POST /:id/members {emails[], role}`, `PATCH /:id/members/:userId {role}`, `DELETE /:id/members/:userId`;
  `PUT /:id/grants {policyIds[], modelIds[]}`; `GET /:id/usage?days`.
- **Managers and members** (`routes/groups.ts`, `requireAuth`; non-managers get 404, never 403):
  `GET /api/groups/mine` (the share dialog's groups); `GET /api/groups/managed`;
  `GET /api/groups/managed/:id/members?search&page`; `POST …/members {emails[]}` (adds `member`);
  `DELETE …/members/:userId` (a member, or oneself). `settingsSummary` in `GET /api/me` (`routes/me.ts:151`) gains
  `managedGroups`, so the Settings tab appears only for managers (`visibleTabs`, `settings-layout.tsx`).
- **Sharing** (`routes/projects.ts`): `GET /api/projects/:id/access` (any access: `access`, `ownerName`, counts);
  owner only: `GET /:id/shares`, `POST /:id/shares {subject: {type:'person', email} | {type:'group', groupId},
  permission}` (a group must be one the owner belongs to; a person is found by exact email; not oneself),
  `PATCH` and `DELETE /:id/shares/:shareId`, `POST /:id/transfer {email}` (target must be a **direct** editor);
  `POST /:id/leave` (409 when access is only through a group). Existing project routes keep their paths; guards
  follow the matrix.

## Lifecycle

**When access ends** (share removed or downgraded, member removed or leaving, group deleted, transfer), in the same
transaction with the project row locked first (the order `uploadAttachment` uses), `reconcileProject(tx, id)`:
(a) sets `thread.project_id = null` for the threads of people who now have no access (one statement over
`thread_project_idx`; for a membership removal, over that person's threads by `user_id`); (b) moves finished files
of anyone no longer editor or owner to the owner (`UPDATE attachment SET user_id`), adjusting both `storage_usage`
rows in user-id order (`adjustStorageUsage`); it never refuses for lack of allowance, as a fork never does
(`docs/dev/database.md`, "Files in forks and edits"). A job `projects.reconcile-access` (every minute, with the
others in `services/jobs/index.ts`) repeats it for leftovers such as an upload that finished after the uploader lost
access; `storage.recompute-usage` heals counters.

**What the person keeps and loses.** Next request: the project vanishes from their lists, files cannot be listed or
downloaded, and the next turn of a conversation they had in it carries no instructions and no passages. A reply
already streaming finishes with the context it began with. Their messages, and what the model already said in
them, including the stored `data-project-search` note, stay: **text the person has already seen is not recalled**,
and the docs say it plainly. Their conversations leave the project; if access returns they move them back.

**Delete a project** (owner): files deleted, everyone's threads leave it (`SET NULL`, as today), shares cascade;
refused, with the existing hold message, when the owner or the uploader of any file is on legal hold.
**Delete the owner's account:** project, shares and files cascade and other people's threads leave it (today's
behaviour); the admin and self-service dialogs now say how many shared projects and other people's conversations
are affected, and the `user.delete` event records `sharedProjects`; refused also while any file in the owner's
projects was added by a person on hold. **Delete an editor's account:** `deleteUser` first moves the files they
added to the owners (else the cascade on `attachment.user_id` deletes another person's project content). Membership
rows cascade.
**Transfer:** `project.user_id` changes; the old owner gets a direct editor share; files stay (I-1 holds, no
counters move). Refused when the target has 100 projects, `projects` off, or no direct editor share. Locks: user
rows in id order, then the project.

**Legal hold.** `group`, `groupMember`, `quotaPolicyGroup`, `modelGroupAccess` and `projectShare` deletions are
configuration, listed `exempt` in `legal-hold-paths.unit.test.ts` (it fails otherwise). Deleting a project or file
is refused when the actor **or the uploader** is held (live row extended). A file-ownership transfer is not a
deletion and is allowed.

**Lock order**, extending `projects.ts:28-34`: acting person's user row (KEY SHARE), project row, thread rows,
`storage_usage` rows by user id. Group changes: group row, then user rows by id.

## Interaction with other features

- **SSO provisioning: recommend no group assignment from claims in v0.14.** Role mapping runs at every sign-in and
  overwrites the role (`auth/provisioning.ts:166-193`); group sync would need rules for who wins over a manager's
  edit, what removes someone when a claim disappears, how a claim with hundreds of provider groups is read, and a
  mapping field on `sso_provider` (an existing table). It would also let a misconfigured provider grant budgets,
  models and project access at sign-in. Groups stay manual; SSO sets the role only. A nullable `source` on
  `group_member` can follow later (additive).
- **Roles & access page: yes**, a read-only **Groups** section (members, budgets, extra models, link to Admin ->
  Groups, "Groups add to a role; they never take access away") from `getRolesAccess()`; `RolesAccess` gains an
  optional `groups`. Per-role model counts stay role-only.
- **Usage by group: no** group dimension in the reports (membership changes relabel history; a person in two groups
  counts twice; each reader in `usage-report/` has rollup and event implementations). **Yes, narrowly:** an
  admin-only card on the group page ("usage by current members, last N days") from
  `rollupRows({ level: 'person' })` (`usage-report/source.ts:108`) joined to `group_member`, with the event
  fallback as `usageTotals` has. Managers do not see it. First thing to cut if the schedule slips.

## Audit events

`recordAudit` never throws. All `group.*` actions join `PROTECTED_AUDIT_ACTIONS` (`packages/shared/src/constants.ts:132`,
asserted at `admin-audit-events.live.test.ts:263`): `group.create`, `group.update` (`diffSettings` changes),
`group.delete` (members, grants, shares removed), `group.member.add` and `.remove` (every account, `viaManager`),
`group.member.role`, `group.grants.update` (policy and model ids, before and after). Share events, not protected:
`project.share.create`, `.update`, `.delete`, `project.transfer`, and the system's `project.access.revoked` (counts),
naming the project **id**, subject and permission, never its name or content. `governance.md` says project changes
are not audited; sharing moves content between people, so recommend auditing it and saying so. Webhooks carry them
unchanged; `docs/admin/observability.md` lists the types.

## Web UI

- **Admin -> Groups** (`/admin/groups`, People section of `lib/admin-navigation.ts`): list with search and counts;
  detail with tabs Members (search, paginate, add by emails, role), Budgets and models (two checklists, read-only
  for auditors), Usage, Settings (rename, delete with consequences). User detail shows the person's groups and, under
  Limits, each budget's source.
- **Settings -> Groups** (`/settings/groups`, only when `managedGroups > 0`): the manager's groups, member list, add
  by emails, remove. No grants, no usage.
- **Share dialog** (project page, owner only): people by exact email, groups from `/groups/mine`, permission, current
  list with change and remove, and: "People you share with use this project's instructions and files in their own
  conversations, which stay private to them. Files they add count against their storage." Transfer is in the
  project's Settings tab. Viewers and editors get the page with controls hidden per the matrix (the server is the
  boundary) and Leave. The sidebar gains "Shared with me".

## Rolling upgrade

Pre-deploy migrations only, so new tables exist before any v0.14 replica runs: no readiness fallback. A v0.13
replica knows nothing of them and all its project queries are owner-scoped, so it can never expose more than the
owner's own data. While it serves (or after a rollback):

| What | Effect |
|---|---|
| A recipient reaches v0.13 | 404 for the shared project (flapping behind the balancer): safe |
| A recipient's turn on v0.13 | the project is silently not applied: safe, but the reply ignores it |
| A recipient's conversation in a shared project on v0.13 | hidden from the sidebar (`project_id` set, project not theirs); still in History and search: safe |
| An administrator deletes an editor's account on v0.13 | files they added to others' projects cascade away: **data loss**, only in this window |
| Group budgets / group-granted models on v0.13 | budgets not enforced (fail-open); extra models not offered (fail-closed) |
| A v0.13 owner deletes a project | cascade removes shares: works |

Data stays safe because nothing on v0.13 can read a shared project, every new key cascades so no v0.13 delete fails,
and rows it cannot see are inert. Mitigations: (1) **mixed-version guard**: creating a share or changing grants
answers 409 "An upgrade is still in progress" while any live replica heartbeat reports an older `version`
(`services/jobs/workers.ts:50,70`; more than one replica already requires Redis); (2) docs, `OPERATIONS.md` upgrade
section and the changelog **Upgrade note**: create no groups or shares, and delete no accounts, until the upgrade
finishes; (3) a **rollback note** with the statement that detaches other people's threads from shared projects.
`tools/upgrade-test` gains: shares and groups created by the new release while a v0.13 replica serves, v0.13 owner
flows unchanged, nothing lost.

## Testing strategy

- **Red first:** a viewer's turn fails with "Attachment context changed" (row 13); a group-granted model is refused
  to a member; a group budget is not enforced.
- **The matrix as a table-driven live test** (`project-access-matrix.live.test.ts`; real PostgreSQL, real Hono app
  and services): the table above is data (`{actor, action, expected}`, about 150 cells run for direct and group
  shares), seeded with files each holding a unique canary word. Each cell calls the real route (or context assembly)
  and asserts the status and, for reads, that the canary appears **only** where expected: list, download, assembled
  model input, keyword search, meaning search (`test/fake-embeddings.ts`), rerank (`test/fake-reranker.ts`),
  headings, the stored note, exports. A completeness test fails when a route under `/api/projects`,
  `/api/attachments/:id/content` or a thread route taking a project id is missing from the manifest.
- **Revocation sequences:** after each way access ends (share removed or downgraded, member removed, group deleted,
  transfer, `projects` switched off) the next call is refused, threads are detached, an ex-editor's files moved with
  correct counters, and a streaming turn completes. Concurrent runs: upload vs revoke, project delete vs upload, two
  reconciles.
- **Owner-only regression:** (1) the existing project suites run **unchanged** (`projects-crud`, `projects-files`,
  `projects-conversations`, `project-sidebar`, `chat-project-context`, `chat-project-search-*`, `project-search-*`,
  `legal-hold-paths`); editing an existing assertion needs a review note. (2) A **parity test** keeps the v0.13.1
  owner-only queries as reference code under `__tests__/reference/` and compares them with the new functions on
  generated data with owners and outsiders and no shares. (3) The guard test above.
- **Groups:** budget combination (role only, group only, both, one policy twice, two groups, override on a group
  budget, disabled policy, model scope); model visibility (role, group, both, disabled); manager powers and limits
  (404 for a non-manager, cannot remove a manager); every cap, including the concurrent-add race; audit entries;
  legal-hold rows.
- **Migrations:** `pnpm lint:migrations`; `pnpm db:migrate` on a fresh database and on one at v0.13.1;
  `upgrade-test --from v0.13.1`.
- **Browser** (`groups.spec.ts`, `project-sharing.spec.ts`): admin creates a group, members, a budget and a model; a
  manager adds and removes; an owner shares with a group as viewer, the viewer uses it and has no editing controls,
  the owner promotes to editor, the editor uploads, the owner removes the share and the viewer's next message has no
  project context; keyboard, axe, phone width.
- **Coverage floors** (`apps/api/vitest.config.ts`): new `project-sharing/access.ts` and `groups/membership.ts`
  100/95/100 (statements/branches/functions); other new service files 95/90/100; existing floors of
  `project-context.ts`, `retrieval.ts`, `attachment-context.ts` and `quota/policy.ts` do not drop. A declarative
  `group` statement (`read`, `manage`) may be added to `auth/permissions.ts` (floor 100%); enforcement stays
  `requireAdmin` plus membership checks.

## Files touched (expected)

Migrations `0053_groups.sql`, `0054_project_shares.sql` (+ journal) and `schema/groups.ts`; shared schemas
(`groups.ts`, `projects.ts`, `admin.ts`, `constants.ts`); API: `services/groups/*`,
`services/project-sharing/{access,shares,transfer,reconcile}.ts`, and every file in the query table; routes
`groups.ts`, `admin/groups.ts`, `admin/index.ts`, `projects.ts`, `me.ts`; web: admin Groups pages, Settings Groups
tab, `share-dialog.tsx`, project page, sidebar, navigation, router, hooks; tests above; `tools/upgrade-test`; docs:
new `docs/admin/groups.md` and `docs/user/groups.md`; `docs/user/projects.md` (drop "Projects are private to you";
sharing; the limits of revocation), `docs/admin/{governance,people,README,observability}.md`, `docs/OPERATIONS.md`,
`docs/dev/database.md` (layout, invariants, lock order), `CHANGELOG.md` (with **Upgrade note**), `ROADMAP.md`.

## Commands (module-specific)

```sh
pnpm lint:migrations
pnpm db:migrate                       # fresh database, and one at v0.13.1
python3 $H/run.py test groups <new live and unit tests>
python3 $H/run.py test projects <the unchanged project suites>
python3 $H/run.py coverage
node tools/upgrade-test/run.mjs --from v0.13.1
```

## Boundaries (module-specific)

- **Always:** answer 404, never 403, to a person with no access; compute access per request; keep every existing
  owner-only assertion passing unedited; charge files and embeddings to the uploader and questions to the asker;
  audit group changes.
- **Ask first:** an `ALTER` of an existing table (none planned); a group effect beyond budgets and models; any way
  for an administrator or auditor to read project content; SSO group sync.
- **Never:** cache membership or shares across requests; change a project query without a row in the table above;
  delete a person's conversation or message when access ends; use `RESTRICT` toward an existing table; let a
  manager see grants or usage.

## Success criteria

The matrix passes in every cell and fails when any cell is mutated; the guard test lists every project-data query;
the unchanged project suites and the parity test pass; budget, model and manager tests pass; `checks`,
`lint:migrations`, floors (zero skips) and `upgrade-test --from v0.13.1` pass; browser suites and a `dev-env` check
(group created, project shared with it, a member uses it, owner revokes, the next message has no context) pass; docs,
CHANGELOG **Upgrade note** and ROADMAP updated; QA screenshots of the three new screens read before merging.

## Decisions (were open questions; every recommendation accepted 2026-10-14; Q10: use the journal `when` values 1790539200033 for 0053 and 1790539200034 for 0054, idx = journal position on your branch, the coordinator renumbers at merge)

1. **An ex-editor's files** (share removed, group left): move to the owner (recommended); or delete them; or leave
   them counted to someone who can no longer remove them. Moving keeps project content and frees the person's quota
   but puts bytes on an owner who did not upload them.
2. **Deleting an editor's account:** move their files to the owners (recommended) versus erase all they uploaded; an
   erasure request would not remove those files.
3. **Deleting an owner's account:** cascade with a loud warning (recommended, today's behaviour) versus moving the
   project to a direct editor automatically.
4. **Mixed-version guard** on shares and grants (recommended, about 40 lines, needs heartbeats, which need Redis
   beyond one replica) versus documentation only.
5. **Group budgets cannot exceed a role budget** (AND; recommended) versus a later "replaces the role's budget" flag.
6. **Audit share events without project names** (recommended); protect only `group.*`.
7. **No notification** when a project is shared (recommended); it appears under "Shared with me".
8. **Sharing with people by exact email** is an account-existence oracle for any signed-in person, as managers
   adding by email also are. Accept with the rate limit (recommended), or restrict people to members of the owner's
   groups.
9. **Last write wins** on instructions, no attribution (recommended; an `updated_by` column would alter `project`).
10. **Journal coordination:** confirm `when` values and `idx` renumbering with the branches taking 0050-0052.
11. **Table name `group`** (as asked; reserved word) versus `user_group`.

## Not verified

Nothing was run: no build, test, migration, `EXPLAIN` or measurement, so costs (the extra group lookup per request,
`reconcileProject` on large groups, the 5,000-member cap) are reasoned, not measured; measure on the scale harness
`small` profile. I did not read `tools/upgrade-test`, the job registration in `services/jobs`, `liveReplicas()` beyond
its `version` field, the project page components in full, the other modules' specs or migration timestamps. I did not
check how Drizzle's migrator treats tag numbers that differ from `idx`, nor how Better Auth's admin plugin reacts to a
new statement. `thread-search.ts`, `thread-history.ts` and `share-links.ts` are judged owner-scoped from having no
project references (grep), not read in full. Line numbers are v0.13.1 (`5d311b64`) and will move.
