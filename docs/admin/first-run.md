# First run

What to do between installing an instance and letting anybody in. Roughly in
order, because each step depends on the one before.

## 1. Sign in as the seeded administrator

The API creates one administrator the first time it starts against an empty
database, from `INITIAL_ADMIN_EMAIL`. If `INITIAL_ADMIN_PASSWORD` was left
blank, a one-time password is printed to the container's output — retrieve it
with `docker compose logs api`.

**Change that password immediately** if it came from an environment file, where
it may also be in your shell history.

That account is also your way back in if sign-on later breaks, so do not delete
it once you have configured an identity provider. See
[getting back in](../OPERATIONS.md#getting-back-in-when-sign-on-fails).

## 2. Close registration

**Settings → Authentication → Registration** defaults to invite-only. Confirm
it is what you want before the instance is reachable:

- **Open** — anybody who can reach the sign-up page gets an account. Appropriate
  only when the instance is not publicly reachable.
- **Invite only** — an account requires a link you issue.
- **Closed** — no new accounts through the form at all, which is what you want
  once an identity provider is doing the work.

## 3. Add a provider and some models

Nobody can send a message until at least one provider and one model are
enabled. [Models and providers](models-providers.md) covers this.

Adding a provider does not expose its models. You choose which appear, and to
which roles, one at a time — so a provider offering forty models does not
present forty to your users.

## 4. Set the limits before opening the doors

Quotas applied after people have started working feel like a punishment;
applied beforehand they are simply how the instance works.

At minimum decide:

- **A usage quota per role.** See [governance](governance.md#usage-quotas).
- **A storage limit per role**, if attachments are on.
- **A retention period**, which is easier to shorten later than to introduce.

## 5. Configure email, or accept the consequence

Without SMTP, the instance cannot send invitations, password resets, or
verification. **Settings → Email** configures it, and
[Health](operations.md#health) will keep saying so until it is set or you have
decided you do not need it. If email verification is required, missing or failed
SMTP leaves new accounts unverified and unable to sign in. Test delivery before
enabling that requirement; an outage never disables it automatically.

## 6. Connect your identity provider

[Identity and access](identity.md) covers OIDC and SAML in full. Two things
there deserve attention before you rely on it:

- **Require a matching role**, or every account your provider will authenticate
  gets access to your instance. It is off by default so an upgrade cannot lock
  people out.
- **Verify a real sign-in** before turning off local authentication.

## 7. Publish an acceptable use policy

If your institution needs people to agree to terms,
[publish it](governance.md#acceptable-use) before opening the instance. A policy
published later prompts everybody at once, which is noisier than doing it first.

## 8. Look at Health

[Health](operations.md#health) tells you whether what you just configured is
actually working. A green page here is a better sign that you are ready than
having ticked off this list.
