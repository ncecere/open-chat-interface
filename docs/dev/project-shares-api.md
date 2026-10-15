# Project sharing API (v0.14, #394)

For the web build: every endpoint, request and response of project sharing. Types and Zod schemas are in
`packages/shared/src/schemas/projects.ts` (all exported from `@oci/shared`). The rules are in
`SPEC-groups.md` ("Access rules", the matrix); this note is the contract.

All routes are under `/api/projects`, need a signed-in person, and need the role's `projects` switch
(403 `FORBIDDEN` when off, as today). **The server is the boundary**: the web hides controls per the matrix, but a
forbidden call still answers 403 or 404.

## Access vocabulary

`access` is one of `owner | editor | viewer` (`ProjectAccessLevel`). A share grants `viewer` or `editor`
(`ProjectSharePermission`); the highest of a person's direct share and their groups' shares wins.

Status rules, in this order: no `projects` switch -> 403; **no access to the project -> 404 `Project not found`**
(existence never leaks; also for administrators and auditors, who are outsiders to project content); access but too
little permission -> 403 `FORBIDDEN`.

| Action | Owner | Editor | Viewer |
|---|---|---|---|
| Read (`GET /:id`, `/:id/files`, `/:id/access`), download a file, use in own conversations, start or move an own conversation into it | yes | yes | yes |
| `PATCH /:id` with `instructions` | yes | yes | 403 |
| `PATCH /:id` with `name` (alone or with instructions) | yes | 403 | 403 |
| `POST /:id/files`, `DELETE /:id/files/:fileId` (any file) | yes | yes | 403 |
| `DELETE /:id`, `GET/POST /:id/shares`, `PATCH/DELETE /:id/shares/:shareId`, `POST /:id/transfer` | yes | 403 | 403 |
| `POST /:id/leave` | 409 (owners transfer or delete) | yes if the share is direct, 409 if only via a group | same |

Conversations stay private: nobody reads another person's conversation through a project. A person's own
conversations are listed by `GET /api/threads?projectId=` exactly as today (`thread.user_id`-scoped).

## Errors

Same envelope as everywhere (`{ error: { code, message, details? } }`). Sharing refusals that need a branch carry
`details: { reason }`, one of `PROJECT_SHARE_ERROR_REASONS`:

| `reason` | Status / code | Meaning |
|---|---|---|
| `upgrade_in_progress` | 409 `CONFLICT` | A replica of the previous release is still serving; creating shares waits. Message: "An upgrade is still in progress. Try again when it has finished." |
| `already_shared` | 409 `CONFLICT` | Already shared with that person or group; use `PATCH`. |
| `share_limit` | 422 `VALIDATION_FAILED` | `MAX_SHARES_PER_PROJECT` (50; a group counts one). The message states the number. |
| `inbound_limit` | 422 | The person already has `MAX_DIRECT_INBOUND_SHARES_PER_USER` (100) projects shared with them directly. |
| `person_not_found` | 422 | No account with that exact email. |
| `cannot_share_with_self` | 422 | The owner named themselves. |
| `not_a_group_member` | 422 | A group must be one the owner belongs to (also answered for an unknown group id). |
| `leave_via_group` | 409 | Access is only through a group. |
| `transfer_target_not_editor` | 422 | The target must already hold a **direct** editor share. |
| `transfer_target_project_limit` | 422 | The target already has `MAX_PROJECTS_PER_USER` projects. |
| `transfer_target_projects_off` | 422 | The target's role does not allow projects. |
| `legal_hold` | 409 | Deleting a project or file is refused while the actor, the owner or the uploader of a file is on legal hold (the existing hold message). |

Share writes and exact-email lookups share one fixed limit: `PROJECT_SHARE_RATE_LIMIT_PER_MINUTE` (30 a minute
per person) -> 429 `RATE_LIMITED` with `Retry-After`.

## Endpoints

### Existing routes, changed

- `GET /api/projects` -> `ProjectList`: `{ projects: ProjectSummary[], shared: ProjectSummary[] }`. `projects` is
  **only the caller's own** (as before, so an older bundle never treats a shared project as its own); `shared` is
  new: projects shared with the caller directly or through a group, with `access` (`viewer | editor`) and
  `ownerName`, at most 100, by name.
- `GET /api/projects/sidebar` -> `SidebarProjectList`: `{ projects: SidebarProject[], shared: SidebarProject[] }`.
  `threadCount` and `recentThreads` are always **the caller's own** conversations in that project.
- `GET /api/projects/:id` -> `{ project: ProjectSummary }`; `access` and, for non-owners, `ownerName` are set.
  `fileCount` counts every ready file; `threadCount` counts the caller's own conversations. 404 without access.
- `PATCH /api/projects/:id` -> `{ project }`. Body as before (`name?`, `instructions?`). Editors may send
  `instructions` only (403 when `name` is present, even alongside instructions). Last write wins.
- `DELETE /api/projects/:id` -> `{ ok, detachedThreads, removedFiles }`. Owner only. 409 `legal_hold` when the
  owner or any file's uploader is on hold.
- `GET /api/projects/:id/files` -> `{ files: ProjectFile[] }`: every ready file of the project, with `addedBy`
  (display name, never an email) and `addedByMe`.
- `POST /api/projects/:id/files` -> 201 `{ files }`. Owner or editor. The upload counts against the **uploader's**
  storage, role limits and rate limit; the 20-file cap is per project.
- `DELETE /api/projects/:id/files/:fileId` -> `{ ok: true }`. Owner or editor removes any file. 409 `legal_hold`
  when the actor or the uploader is on hold.
- `GET /api/attachments/:id/content`: own file, or a live project file the caller can read (viewer or better).
- `POST /api/threads {projectId}` and `PATCH /api/threads/:id {projectId}` accept a project the caller can read at
  any level; the thread stays the caller's. 404 without access.

### New routes

- `GET /api/projects/:id/access` (any access) -> `ProjectAccessInfo`:
  `{ access, ownerName, personShares, groupShares, canLeave }`. Counts only: a non-owner never sees who else has
  access.
- `GET /api/projects/:id/shares` (owner) -> `{ shares: ProjectShare[] }`, oldest first. A share is
  `{ id, permission, subject, createdAt, updatedAt }` with `subject` either
  `{ type: 'person', userId, name, email }` or `{ type: 'group', groupId, name, memberCount }`.
- `POST /api/projects/:id/shares` (owner) body `CreateProjectShareInput`:
  `{ subject: { type: 'person', email } | { type: 'group', groupId }, permission: 'viewer' | 'editor' }`
  -> 201 `{ share: ProjectShare }`. The person is found by **exact email** (case-insensitive); a group must be one
  the owner belongs to; not oneself. No notification is sent: it appears under "Shared with me". Refusals: see the
  reasons above (`upgrade_in_progress`, `already_shared`, `share_limit`, `inbound_limit`, `person_not_found`,
  `cannot_share_with_self`, `not_a_group_member`) and 429.
- `PATCH /api/projects/:id/shares/:shareId` (owner) body `{ permission }` -> `{ share }`. A downgrade to `viewer`
  ends the person's (or group's) editing at once: files they added are handed to the owner and the project's
  access is reconciled.
- `DELETE /api/projects/:id/shares/:shareId` (owner) -> `{ ok, detachedThreads, movedFiles }`: the conversations
  of people who now have no access leave the project (nothing is deleted); files added by people who are no longer
  editors move to the owner.
- `POST /api/projects/:id/transfer` (owner) body `{ email }` -> `{ project }` (the caller's new view, as `editor`).
  The target must hold a direct editor share; the old owner becomes a direct editor.
- `POST /api/projects/:id/leave` (editor or viewer with a direct share) -> `{ ok, detachedThreads, movedFiles }`.
  409 `leave_via_group` when access is only through a group; 409 for the owner.

### Not in this note

Group management (`/api/admin/groups`, `/api/groups/*`) belongs to the groups module. The share dialog needs
`GET /api/groups/mine` from it to list the groups the owner can pick.

## Audit and webhooks

`project.share.create`, `project.share.update`, `project.share.delete`, `project.transfer` and the system's
`project.access.revoked` (counts) name the project **id**, the subject and the permission, never the project's
name or content. They are not protected from retention. Constant: `PROJECT_SHARE_AUDIT_ACTIONS`.

## Rolling upgrade

While any live replica reports an older version, `POST /shares` and `POST /transfer` answer 409
`upgrade_in_progress`. Changing and removing shares, leaving, and every read stay available.
