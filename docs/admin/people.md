# People

![The user list](../images/admin-users.png)

## Finding somebody

Search matches names and email addresses; the filters narrow by role and by
status. All three are applied **on the server**, so they describe every account
rather than the page in front of you — which matters once the directory is
larger than one page.

Sorting works the same way. Sorting by messages finds the heaviest users across
the whole instance, not the heaviest fifty on this page.

### Saved views

A set of filters you return to — "restricted accounts", "unverified" — saved by
name and shown as a chip above the list.

Views are **yours**, not the instance's. Two administrators looking at the same
directory rarely want the same slice of it, and "accounts I still have to
review" is a working note rather than configuration.

## Looking at one person

![A user's detail](../images/admin-user-detail.png)

The detail view answers the questions actually asked about an account: what they
have been doing, why they are hitting a limit, whether the account is behaving
oddly.

It shows their totals, storage, **active sessions with the address and client
each came from**, recent conversation titles, and their audit trail — matched
both as actor and as target, so something done *to* them appears beside things
they did.

Conversation **titles only**. An administrator managing an account has no reason
to read its contents, and this page does not make that easy.

**Sign out everywhere** ends every session. This is the right response to a
suspected compromise; changing the password alone leaves existing sessions
working.

## Bulk actions

![Selecting several accounts](../images/admin-users-bulk-actions.png)

Select rows and the action bar appears. Roles, bans, and session revocation can
be applied to a selection.

Three behaviours worth knowing:

- **You cannot include your own account.** Selecting only yourself is refused;
  selecting yourself alongside others silently skips you and says so. Locking
  yourself out mid-operation is not something the interface will help with.
- **A ban revokes sessions in the same action**, because a ban that leaves the
  session alive is not a ban until it expires.
- **The audit entry names every account affected**, not just a count, so the
  action can be checked afterwards.

Bounded at two hundred per request, so a single action cannot rewrite the
directory by accident.

## Invitations

![Invitations](../images/admin-invitations.png)

When registration is invite-only or closed, an invitation is how somebody gets
an account. Each carries a role, so you decide what they will be before they
arrive.

Links expire. An unused invitation can be revoked, which is worth doing when
somebody's circumstances change between offer and acceptance.

Invitations need email to be configured. Without SMTP you can still create one,
but you will have to deliver the link yourself.

## Per-person limits

**Limits** beside an account sets a quota override for that individual, without
changing the policy for their role.

This is the answer to "my work needs more than the standard allowance". Use it
rather than raising the limit for everybody, and set an expiry if the need is
temporary — an override with no end date is one nobody will remember to remove.
