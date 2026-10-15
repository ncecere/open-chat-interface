import type { AdminMfaStatus } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { ADMIN_USERS_QUERY_KEY } from '~/components/admin/user-role-select';
import { Button } from '~/components/ui/button';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api } from '~/lib/api-client';
import { mfaDeadlineText } from '~/lib/mfa';

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-2.5 text-sm last:border-b-0">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="text-end text-[var(--text-primary)]">{children}</dd>
    </div>
  );
}

/**
 * A person's two-step verification on their administration page (#399): what
 * they have set up, read by auditors too, and Reset, for administrators. A reset
 * removes the authenticator, recovery codes and passkeys and ends their sessions
 * (they are emailed), for the person who lost their phone; administrators cannot
 * reset their own, which would be signing themselves out of the protection.
 */
export function UserMfaSection({
  userId,
  name,
  mfa,
}: {
  userId: string;
  name: string;
  mfa: AdminMfaStatus;
}) {
  const queryClient = useQueryClient();
  const { data: me } = useCurrentUser();
  const [confirming, setConfirming] = useState(false);
  const oneself = me?.user.id === userId;
  const locked = mfa.lockedUntil !== null && Date.parse(mfa.lockedUntil) > Date.now();
  const hasAny = mfa.totp || mfa.passkeys > 0;

  async function reset() {
    await api.post(`/admin/users/${userId}/mfa/reset`, {});
    await queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
  }

  return (
    <section className="mt-8">
      <h2 className="font-semibold text-base">Two-step verification</h2>
      <div className="mt-3">
        {!mfa.eligible ? (
          <p className="text-[var(--text-muted)] text-sm">
            Signs in only through their organisation, which decides how they verify. There is
            nothing to set up or reset here.
          </p>
        ) : (
          <>
            <dl className="overflow-hidden rounded-xl border border-[var(--border-subtle)]">
              <Item label="Authenticator app">{mfa.totp ? 'On' : 'Off'}</Item>
              {mfa.recoveryCodesLeft !== null && (
                <Item label="Recovery codes left">{mfa.recoveryCodesLeft}</Item>
              )}
              <Item label="Passkeys">{mfa.passkeys > 0 ? mfa.passkeys : 'None'}</Item>
              <Item label="Required for their role">
                {mfa.required
                  ? mfa.deadline
                    ? `Yes, by ${mfaDeadlineText(mfa.deadline)}`
                    : 'Yes'
                  : 'No'}
              </Item>
              {locked && <Item label="Second step">Locked after too many wrong codes</Item>}
            </dl>
            {oneself ? (
              <p className="mt-3 text-[var(--text-muted)] text-sm">
                Manage your own under{' '}
                <Link to="/settings" className="text-[var(--accent-bright)] hover:underline">
                  Settings → Account
                </Link>
                .
              </p>
            ) : (
              hasAny && (
                <EditOnly>
                  <div className="mt-3">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setConfirming(true)}
                    >
                      Reset two-step verification
                    </Button>
                  </div>
                </EditOnly>
              )
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Reset two-step verification for ${name}?`}
        description={`This removes ${name}'s authenticator app, recovery codes and passkeys, and signs them out everywhere. They are emailed. If their role requires two-step verification they must set it up again before they can use the app.`}
        confirmLabel="Reset and sign out"
        pendingLabel="Resetting…"
        errorMessage="Two-step verification could not be reset."
        onConfirm={reset}
      />
    </section>
  );
}
