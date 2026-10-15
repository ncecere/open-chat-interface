import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountDeletionText, deletionConfirmed } from '~/components/account/account-deletion';
import { SharingImpactNotice } from '~/components/account/sharing-impact';
import { SettingsConfirmDialog } from '~/components/settings/confirm-dialog';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useSharingImpact } from '~/hooks/use-project-sharing';
import { api } from '~/lib/api-client';
import { formatList, useT } from '~/lib/i18n';
import { useReadOnlyLock } from '~/lib/read-only';

/**
 * Deleting your own account (v0.10), when an administrator has allowed it for
 * your role under Roles & access. The email must be typed, and an account
 * with a password also enters it. The server refuses under legal hold and for
 * the last administrator; its message is shown in the dialog.
 */
export function DeleteAccountSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useCurrentUser();
  // Deleting an account is refused while read-only (#353).
  const lock = useReadOnlyLock();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  // What deleting does to other people's projects, read when the dialog opens (v0.14).
  const impact = useSharingImpact('/me/sharing-impact', open);
  if (!data) return null;

  if (!data.features.accountDeletion) {
    return (
      <p className="mt-12 text-sm text-[var(--text-muted)]">
        {t('settings.deleteAccount.contactAdmin')}
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
          {t('settings.deleteAccount.title')}
        </h2>
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[var(--danger)]/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[var(--text-muted)]">{t('settings.deleteAccount.warning')}</p>
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
            {t('settings.deleteAccount.title')}
          </Button>
        </div>
      </section>

      <SettingsConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('settings.deleteAccount.dialogTitle')}
        description={<AccountDeletionText subject={{ kind: 'self' }} />}
        confirmLabel={t('settings.deleteAccount.confirm')}
        pendingLabel={t('settings.deleteAccount.pending')}
        errorMessage={t('settings.deleteAccount.failed')}
        confirmDisabled={
          lock.locked ||
          impact.isLoading ||
          !deletionConfirmed(typed, email) ||
          (needsPassword && !password)
        }
        onConfirm={deleteAccount}
      >
        <div className="flex flex-col gap-4">
          <SharingImpactNotice query={impact} subject="self" />
          {sso.length > 0 && (
            <p
              role="note"
              className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm"
            >
              {t('settings.deleteAccount.sso', { providers: formatList(sso) })}
            </p>
          )}
          <Field
            label={t('settings.deleteAccount.typeEmail', { email })}
            htmlFor="delete-account-confirm"
          >
            <Input
              id="delete-account-confirm"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
          {needsPassword && (
            <Field label={t('settings.deleteAccount.password')} htmlFor="delete-account-password">
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
      </SettingsConfirmDialog>
    </>
  );
}
