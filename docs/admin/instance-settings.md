# Instance settings

![Instance settings](../images/admin-settings.png)

Three tabs: **General**, **Authentication**, and **Email & SMTP**.

## General

**Appearance** sets the accent colour applied across the instance. Surfaces stay
neutral; only the accent changes, so a choice here cannot make text unreadable.

**Default model** is what a new conversation starts with. It belongs here rather
than on the model itself, so there is one place to look and one source of truth.
Choose something reasonable for everyday work rather than your most capable
option — everyone gets it by default, including people who would not have chosen
it.

**Default system prompt** is sent with every conversation on the instance. Keep
it short. A long prompt is charged on every message and is the first thing to
suspect when replies drift from what people expect.

**Features** turn capabilities off instance-wide: sharing, temporary chats, web
search, attachments, branching. Turning one off removes it from the interface
rather than leaving a control that fails.

## Authentication

Covered in full under [identity and access](identity.md). In summary:
registration mode, email verification, whether local sign-in is available, and
session lifetime.

## Email and SMTP

Host, port, credentials, and the address mail is sent from.

Without this, the instance cannot send invitations, password resets,
verification, or [scheduled reports](audit-reporting.md#scheduled-reports).
Everything else works.

The password is write-only: once saved it is encrypted and never returned. The
form shows whether one is set.

**Verification interacts with this.** Requiring email verification without
working SMTP would lock out every new account, so the instance suppresses the
requirement until email is configured, and says so on the page rather than
failing quietly.

## Branding

![Branding](../images/admin-branding.png)

The instance name, a short name, a logo, and a message on the sign-in page.

**The logo is uploaded, not linked.** A linked image would disappear if the host
serving it did, on the one page people see before they can sign in.

**SVG is refused.** The logo renders before authentication, and SVG can carry
script, which would make it stored cross-site scripting on your sign-in page.
PNG, JPEG, and WebP are accepted, validated by content rather than extension,
up to 1 MB.

The wordmark falls back in order: logo, then short name, then initials. An
instance with none of them still renders something sensible.

## Announcements

![Announcements](../images/admin-announcements.png)

A banner shown to everybody — planned maintenance, a change of policy, an
incident.

- **A banner, not a toast.** A maintenance notice has to stay readable rather
  than fading after four seconds.
- **Dismissal is per person.** One person hiding it does not hide it for
  everyone.
- **Editing does not re-show it.** Fixing a typo should not interrupt people who
  already read it. A separate **re-show** action clears dismissals when the
  change genuinely matters.
- **Non-dismissable is enforced at the server**, not by hiding the button.

Audience can be limited by role, which is how a message meant for staff avoids
students.
