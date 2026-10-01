# First run

What to do between installing an instance and letting anybody in. The steps
follow the setup checklist on **Overview**, which is in the order things depend
on each other.

## Sign in as the seeded administrator

The API creates one administrator the first time it starts against an empty
database, from `INITIAL_ADMIN_EMAIL`. If `INITIAL_ADMIN_PASSWORD` was left
blank, a one-time password is printed to the container's output — retrieve it
with `docker compose logs api`.

**Change that password immediately** if it came from an environment file, where
it may also be in your shell history.

That account is also your way back in if sign-on later breaks, so do not delete
it once you have configured an identity provider. See
[getting back in](../OPERATIONS.md#getting-back-in-when-sign-on-fails).

## Reading the checklist

![The administrative overview](../images/admin-overview.png)

The checklist is worked out by the server from stored configuration, so an item
is complete when the setting it depends on is actually in place, not when you
have visited a page. Nothing in it contacts an external service: a provider key
or SMTP server that is saved but rejected shows up on
[System health](operations.md#health), not here.

Each item has one of three states:

- **Needs attention** — something is missing or broken. Items marked
  **Required** count towards the progress bar.
- **Not set up** — optional, and currently off.
- **Complete** — hidden behind **Show completed** until you want to see it.

Items needing attention are listed first. Once every required item is complete
the panel collapses to **Setup complete**, but anything optional that is
switched on and broken is still shown.

Every item links to the page that resolves it. An auditor sees the same list.

## 1. Connect a model provider

**Models → Providers & Models**, Providers tab. Complete when at least one provider is
enabled, valid, and has its credential — or, for an OpenAI-compatible server,
needs none. [Models and providers](models-providers.md) covers this.

## 2. Enable at least one model

Same page, Models tab — use **Discover models** on a provider first. Adding a
provider does not expose its models. You choose which
appear, and to which roles, one at a time — so a provider offering forty models
does not present forty to your users. The item is complete when an enabled
model belongs to an enabled provider.

## 3. Choose a default model

Models tab, above the catalogue. The default is what a new conversation starts
with. The checklist accepts it only when exactly one model is the default, it
is available, and it is visible to the `user` role — a default that ordinary
users cannot see is not a default for them.

## 4. Offer a way to sign in

**Sign-in & security → Authentication.** Complete when local email and password
sign-in is on, or at least one single sign-on provider is enabled.

While you are on that page, check **Registration mode**. It defaults to invite
only. Confirm it is what you want before the instance is reachable:

- **Open** — anybody who can reach the sign-up page gets an account. Appropriate
  only when the instance is not publicly reachable.
- **Invite only** — an account requires a link you issue.
- **Closed** — no new accounts through the form at all, which is what you want
  once an identity provider is doing the work.

If you are connecting an identity provider, [Identity and access](identity.md)
covers OIDC and SAML in full. Two things there deserve attention before you rely
on it:

- **Require a matching role**, or every account your provider will authenticate
  gets access to your instance. It is off by default so an upgrade cannot lock
  people out.
- **Verify a real sign-in** before turning off local authentication.

## 5. Set up email delivery

**Sign-in & security → Email delivery.** Optional until something depends on
it: the item becomes required when email verification is required or a
scheduled report is enabled.

Without SMTP, the instance cannot send invitations, password resets, or
verification; invitation links have to be shared by hand. If email verification
is required, missing or failed SMTP leaves new accounts unverified and unable to
sign in. Confirm that mail actually arrives before enabling that requirement; an
outage never disables it automatically.

## 6. Configure attachment storage

**Data & storage → Storage.** The local filesystem always counts as complete —
back up that volume. If you select S3-compatible storage, the item stays in
need of attention until the bucket settings are complete. Running more than one
API replica needs S3; see the [README](../../README.md#running-more-than-one-api-replica).

## 7. Web search (optional)

**Appearance & features → Web search.** Off is a valid choice. Once switched
on, the item needs attention until a provider and its credential (or, for
SearXNG, a base URL) are saved. Until then people are simply not offered search.

## 8. Publish an acceptable use policy (optional)

**Sign-in & security → Acceptable use.** If your institution needs people to
agree to terms, [publish it](governance.md#acceptable-use) before opening the
instance. A policy published later prompts everybody at once, which is noisier
than doing it first.

## 9. Connect Redis for multiple replicas (optional)

Set with `REDIS_URL` in the environment, not in the dashboard. Without it, rate
limits and stream recovery work per replica only. The checklist reports only
whether it is configured; **System health** reports whether it answers.

## Before opening the doors

The checklist does not cover limits, because there is no wrong answer to
detect. Decide them anyway: quotas applied after people have started working
feel like a punishment; applied beforehand they are simply how the instance
works.

- **A usage budget per role** on **Models → Usage budgets**. See
  [governance](governance.md#usage-budgets).
- **Rate limits and a storage allowance per role** on **People → Roles &
  access**.
- **A retention period** on **Data & storage → Retention**, which is easier to
  shorten later than to introduce.

Then open [System health](operations.md#health). It tells you whether what you
configured is actually working. A green page there is a better sign that you
are ready than a completed checklist.
