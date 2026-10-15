# Two-step verification

Two-step verification protects your account if somebody learns your password.
After the password, you also give something only you have: a code from an
authenticator app on your phone, or a passkey. It is in **Settings → Account**,
under **Two-step verification**.

It is for accounts that sign in with an email address and a password. If you
sign in through your organisation, the row says **Managed by your organisation**:
your organisation's own sign-in decides what it asks of you, and there is
nothing to set up here.

## Setting it up

You need an authenticator app (any app that supports time-based one-time
codes: your phone's password manager, or an app such as Aegis, 2FAS or Microsoft
Authenticator).

1. In **Settings → Account**, choose to set up an authenticator and enter your
   password.
2. Scan the QR code with the app. If you cannot scan it, type the **key** shown
   under it into the app (it can be selected and copied), or open the link on
   your phone.
3. Type the six-digit code the app shows now and confirm.
4. **Save your recovery codes.** You are shown ten, once. Each works a single
   time if you lose your phone. Copy, download or print them, and keep them
   somewhere other than the phone. They are not shown again; the page only says
   how many are left.

You are signed in again as you finish, so this device carries on without
asking.

## Signing in

Enter your email and password as usual. If you have two-step verification, you
are then asked for an **Authentication code**:

- type the six digits from your app (a space in the middle is fine, and you can
  paste it);
- or choose **Use a recovery code instead** and type one of your recovery codes
  (case matters; the hyphen can be left out).

A code works once: after you use it, the next sign-in within a couple of
minutes asks for the next code the app shows. Five wrong codes end the attempt
(choose **Start again**), and ten wrong codes in a row lock the second step for
15 minutes. If you have a passkey you can choose **Sign in with a passkey**
instead: it needs no password and no code.

There is no "remember this device": a shared computer is asked every time.

If you use a recovery code, you are emailed (when your administrator has set up
email) and the page tells you how many are left. Make a new set before you run
out.

## Recovery codes

In **Settings → Account → Two-step verification**, **Make new recovery codes**
needs your password and a current code. It replaces the whole set: the old
codes stop working. Use it if you used several, or if you think somebody saw
them.

## Passkeys

A passkey is a key kept on your device (or in your password manager) that you
unlock with your fingerprint, face or device PIN. It cannot be typed into a fake
website, so it is the strongest option where your devices support it.

- **Add a passkey** from the same row. You must have signed in recently; if
  not, enter your password and sign in again first.
- A passkey must verify *you* (a PIN, fingerprint or face). A security key that
  only checks that it was touched is refused, because it would be one factor
  pretending to be two.
- You can **rename** and **remove** passkeys. They are listed with a name, the
  kind of device and whether they are backed up.
- A passkey belongs to the web address of this service. If your administrator
  moves the service to a new address, the passkeys stop working there (your
  password and authenticator still do).

## Turning it off

**Turn off the authenticator** asks for your password **and** a current code (an
authenticator code or a recovery code), so somebody at an unlocked screen cannot
remove it. Your passkeys stay until you remove them. If your administrator
requires two-step verification for your role, you cannot go without it: you are
asked to set it up again.

## When your administrator requires it

An administrator can require two-step verification for a role, after a grace
period. Before the deadline a banner reminds you ("Set up two-step verification
by …"). After it, until you set it up you can only reach the setup page and sign
out, and any other page shows that. Setting it up (or signing in with a passkey,
or through your organisation) lifts that straight away.

## If you are locked out

If you lost your phone and your recovery codes, ask an administrator to reset
your two-step verification: it removes your authenticator, recovery codes and
passkeys and signs you out everywhere, and you can sign in with your password
and set it up again. You are emailed when this happens.

Authenticator codes depend on the time on your phone. If correct codes are
refused, check that the phone's date and time are set automatically.

## What is recorded

Setting it up, turning it off, new recovery codes, passkeys, wrong codes and
resets are recorded in the audit log, never the codes or the key themselves, and
you are emailed about changes when email is set up.
