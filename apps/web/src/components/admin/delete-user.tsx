import type { AdminUser } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountDeletionText, deletionConfirmed } from '~/components/account/account-deletion';
import { EditOnly } from '~/components/admin/admin-access';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { ADMIN_USERS_QUERY_KEY } from '~/components/admin/user-role-select';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api } from '~/lib/api-client';

/**
 * Permanently deleting one account, from its detail page.
 *
 * Confirmation is typed rather than clicked: the email has to be entered, so
 * the wrong account cannot be deleted with a stray Enter. The server refuses
 * your own account, the last administrator and anyone on legal hold; its
 * reason is shown in the dialog. Hidden from read-only viewers and on your
 * own account, which the server refuses anyway.
 */
export function DeleteUserSection({
  user,
}: {
  user: Pick<AdminUser, 'id' | 'name' | 'email'> & { legalHold?: boolean };
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  if (me.data?.user.id === user.id) return null;

  const name = user.name || user.email;
  const held = Boolean(user.legalHold);

  async function deleteAccount() {
    await api.delete(`/admin/users/${user.id}`);
    await navigate({ to: '/admin/users' });
    // This account's queries would only ever 404 now; the listing must drop it.
    queryClient.removeQueries({ queryKey: [...ADMIN_USERS_QUERY_KEY, user.id] });
    await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
  }

  return (
    <EditOnly>
      <section className="mt-8">
        <h2 className="font-semibold text-base">Delete account</h2>
        <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--danger)]/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[var(--text-muted)] text-sm">
            Permanently delete this account and everything it owns. The audit log keeps its entries.
          </p>
          <Button
            type="button"
            size="sm"
            variant="danger"
            className="shrink-0"
            onClick={() => {
              setTyped('');
              setOpen(true);
            }}
          >
            Delete user
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${name}?`}
        description={<AccountDeletionText subject={{ kind: 'admin', name }} />}
        confirmLabel="Delete user"
        pendingLabel="Deleting…"
        errorMessage="The account could not be deleted."
        confirmDisabled={held || !deletionConfirmed(typed, user.email)}
        onConfirm={deleteAccount}
      >
        {held ? (
          <p
            role="note"
            className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm"
          >
            This person is on legal hold, so their account cannot be deleted. Lift the hold under
            Data &amp; storage → Compliance first.
          </p>
        ) : (
          <Field label={`Type ${user.email} to confirm`} htmlFor="delete-user-confirm">
            <Input
              id="delete-user-confirm"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        )}
      </ConfirmDialog>
    </EditOnly>
  );
}
