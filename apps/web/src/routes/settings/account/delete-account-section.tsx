import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountDeletionText, deletionConfirmed } from '~/components/account/account-deletion';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api } from '~/lib/api-client';
import { useReadOnlyLock } from '~/lib/read-only';

/**
 * Deleting your own account (v0.10), when an administrator has allowed it for
 * your role under Roles & access. The email must be typed, and an account
 * with a password also enters it. The server refuses under legal hold and for
 * the last administrator; its message is shown in the dialog.
 */
export function DeleteAccountSection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useCurrentUser();
  // Deleting an account is refused while read-only (#353).
  const lock = useReadOnlyLock();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  if (!data) return null;

  if (!data.features.accountDeletion) {
    return (
      <p className="mt-12 text-sm text-[var(--text-muted)]">
        To delete your account, contact your administrator.
      </p>
    );
  }

  const email = data.user.email;
  const needsPassword = Boolean(data.signIn?.credential);
  const sso = data.signIn?.sso ?? [];

  async function deleteAccount() {
    await api.post('/me/delete-account', {
      confirmEmail: typed,
      ...(needsPassword ? { password } : {}),
    });
    queryClient.clear();
    await navigate({ to: '/auth/login' });
  }

  return (
    <>
      <section className="mt-12" aria-labelledby="delete-account-heading">
        <h2 id="delete-account-heading" className="text-xl font-bold">
          Delete account
        </h2>
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[var(--danger)]/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[var(--text-muted)]">
            Permanently delete your account and everything it owns. This cannot be undone.
          </p>
          <Button
            type="button"
            size="sm"
            variant="danger"
            className="shrink-0"
            locked={lock.title}
            onClick={() => {
              setTyped('');
              setPassword('');
              setOpen(true);
            }}
          >
            Delete account
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account?"
        description={<AccountDeletionText subject={{ kind: 'self' }} />}
        confirmLabel="Delete my account"
        pendingLabel="Deleting…"
        errorMessage="Your account could not be deleted."
        confirmDisabled={
          lock.locked || !deletionConfirmed(typed, email) || (needsPassword && !password)
        }
        onConfirm={deleteAccount}
      >
        <div className="flex flex-col gap-4">
          {sso.length > 0 && (
            <p
              role="note"
              className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm"
            >
              You sign in through {sso.join(', ')}. If you sign in that way again later, a new,
              empty account is created for you.
            </p>
          )}
          <Field label={`Type ${email} to confirm`} htmlFor="delete-account-confirm">
            <Input
              id="delete-account-confirm"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
          {needsPassword && (
            <Field label="Your password" htmlFor="delete-account-password">
              <Input
                id="delete-account-password"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
