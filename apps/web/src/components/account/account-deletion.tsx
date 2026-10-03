/**
 * What deleting an account removes and keeps, worded once for both places an
 * account is deleted: an administrator under People (v0.10) and the person
 * themselves in Settings → Account (v0.10). Both run the same server code, so
 * they must say the same thing.
 */

/** True once the typed text is the account's email, ignoring case and outer spaces. */
export function deletionConfirmed(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

const DELETED =
  'conversations and their messages, uploaded files, projects, artifacts, memory, share links, connected accounts, saved views, usage records and preferences';

export function AccountDeletionText({
  subject,
}: {
  /** An administrator deleting someone (by name), or the person deleting their own account. */
  subject: { kind: 'admin'; name: string } | { kind: 'self' };
}) {
  if (subject.kind === 'admin') {
    return (
      <>
        This permanently deletes the account and everything it owns: {DELETED}. {subject.name} is
        signed out straight away. This cannot be undone.
        <br />
        <br />
        The audit log keeps every entry, including this deletion, with the email address it was
        recorded with. Invites and announcements they created stay.
      </>
    );
  }
  return (
    <>
      This permanently deletes your account and everything it owns: {DELETED}. You are signed out
      straight away. This cannot be undone.
      <br />
      <br />
      The audit log keeps every entry, including this deletion, with your email address. Invites and
      announcements you created stay.
    </>
  );
}
