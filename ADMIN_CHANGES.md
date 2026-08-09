# Admin dashboard: controls, data, and scale

What administrators can do, what they can find out, and whether either holds up
at twenty thousand users.

Target scale is **20,000+ users**, taken from a comparable instance already
running. Everything below is judged against that number rather than against a
development database.

---

## Group 0 — Work at scale

Measured against a generated dataset of 20,000 users, 200,000 threads, and
2,000,000 messages.

| Users page action | Now | With an index on `message.user_id` |
| --- | --- | --- |
| Page one, default sort | 2,553 ms | 5 ms |
| Sort by message count | did not finish in 60 s | 147 ms |

`thread` has `thread_user_updated_idx`; `message` has no index on `user_id`, so
the per-user `count(*)` subqueries in `routes/admin/users.ts` scan two million
rows for every user row returned. Server-side sorting by message count was
added in !11 and verified against a database holding one user, where it looked
instant.

- [x] Index `message.user_id`.
- [x] Measure every other aggregating admin query the same way — usage,
      storage, overview, quotas — rather than assuming this was the only one.
- [x] Replace `OFFSET` pagination, which degrades on deep pages, with a cursor.
- [x] Decide whether per-user counts belong in a list at all, or only in a
      detail view.
- [x] Keep a seeded large dataset available so this is checkable, not
      re-discovered.

---

## Group A — Getting people in correctly

The six items originally raised, plus the recovery path they imply.

1. [x] Default role for a user logging in.
       *Already exists as `defaultRole` per provider; confirm it behaves as
       expected once item 6 lands.*
2. [x] JWT and session expiry, where needed.
       *Currently hard-coded: 30 days, refreshed daily, `auth/index.ts`.*
3. [x] Define which claims carry email, username, picture, and subject.
       *No mapping layer exists today.*
4. [x] Send straight to OAuth/OIDC login, skipping the local form.
5. [x] Define where role claims come from and what they are.
       *Already exists as `claimRoleMappings`.*
6. [x] **Reject a login that matches no role**, with a configurable message.
       *Today an unmatched user silently receives `defaultRole`, so everyone an
       identity provider will authenticate gets an account. This is the item
       that turns group mapping into an authorisation boundary rather than a
       label.*
7. [x] A documented break-glass route. If sign-on breaks and administrators are
       themselves sign-on users, there is currently no way back in — and item 4
       makes that sharper by removing the local form from view.

---

## Group B — Seeing and investigating

The half that is largely missing: once somebody is in, an administrator cannot
find out much about them.

8. [x] **Audit authentication events** — sign-in, failure, provisioning, role
       change at login, lockout. All thirty-six audited actions today are
       administrative. Investigation usually begins with who signed in, from
       where, and when, which is currently unanswerable.
9. [x] **Populate `ip_address`.** The column exists on `audit_log` and is null
       on every row.
10. [x] **A user detail view.** There is no drill-down at all: no way to open a
        user and see their threads, usage, sessions, quota state, or audit
        trail. At twenty thousand users a flat sortable list is not an
        investigation tool.
11. [x] **Audit export and server-side date filtering.** The endpoint returns a
        hard-coded two hundred most recent rows and filters in the browser.
        Retention already keeps the history; it simply cannot be reached.
12. [x] **Configuration change history.** `settings.update` is audited, but not
        what changed. "Who disabled sign-on last Tuesday, and what was it
        before" has no answer today.
13. [ ] **Support access to a user's view**, for reproducing a reported
        problem. **Deliberately not built.** It is the one item that lets an
        administrator read somebody's conversations, and it needs a decision
        about consent, scope, and what is recorded before it is written rather
        than after.
14. [x] **An operational health page** — failing providers, storage errors,
        stuck jobs, migration state. Today these surface as user complaints.

---

## Group C — Managing at volume

15. [x] Bulk user actions. Role changes, deactivation, and session revocation
        are one at a time.
16. [x] A read-only auditor role. `admin` is currently all or nothing, and a
        compliance reviewer should not need write access.
17. [x] Saved views and filters.
18. [x] Scheduled usage reports.

---

## Group D — Layout

Deliberately last. The dashboard is twenty-three pages of forms with little to
explore, and a modern layout should follow from deciding what an administrator
needs to answer. Restyling first would produce better-looking forms and the
same blind spots.

19. [x] Consistent list-and-detail pattern, once Group B has established what a
        detail view contains.
20. [x] Cross-linking between entities. An audit row names a model identifier
        that cannot be clicked; a user row cannot reach that user's usage.
21. [x] Overview that shows direction, not just totals. "15 threads in the last
        24 hours" invites the question "up or down from what?"
22. [x] Command palette for administrative navigation.

---

## Notes

- Group 0 comes first because the pages below it are already slow at the target
  scale, and every later feature is built on the same queries.
- Items 8 and 9 are cheapest now: adding them before a year of history exists
  avoids a backfill that cannot be done accurately.
- Group A item 6 is a security gap rather than a missing feature, and is the
  highest-value item in that group.
