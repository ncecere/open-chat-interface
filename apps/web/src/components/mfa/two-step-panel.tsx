import type { MfaStatus } from '@oci/shared';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { PasskeySection } from '~/components/mfa/passkeys';
import { ReauthDialog, type ReauthKind } from '~/components/mfa/reauth-dialog';
import { TotpEnrol } from '~/components/mfa/totp-enrol';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { mfaDeadlineText, useMfaStatus } from '~/lib/mfa';
import { useReadOnlyLock } from '~/lib/read-only';

/** The recovery codes still unused, said plainly, with a warning when they run low. */
function recoveryCodesText(left: number): { text: string; low: boolean } {
  if (left === 0) return { text: 'You have no recovery codes left.', low: true };
  const text = `${left} recovery ${left === 1 ? 'code' : 'codes'} left.`;
  return { text, low: left <= 2 };
}

function Summary({ status }: { status: MfaStatus }) {
  const parts: string[] = [];
  if (status.methods.includes('totp')) parts.push('Authenticator app');
  const passkeys = status.passkeys.length;
  if (passkeys > 0) parts.push(`${passkeys} ${passkeys === 1 ? 'passkey' : 'passkeys'}`);
  const locked = status.lockedUntil && Date.parse(status.lockedUntil) > Date.now();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-[var(--text-secondary)]">
        Status:{' '}
        <Badge variant={status.enrolled ? 'success' : 'neutral'}>
          {status.enrolled ? 'On' : 'Off'}
        </Badge>
        {status.enrolled && parts.length > 0 && (
          <span className="ms-2 text-[var(--text-muted)]">{parts.join(' · ')}</span>
        )}
      </p>
      {status.required && (
        <p className="text-[var(--text-secondary)]">
          {status.limited
            ? 'Your administrator requires two-step verification. Set it up to continue.'
            : status.enrolled
              ? 'Required by your administrator.'
              : `Required by your administrator.${
                  status.deadline ? ` Set it up by ${mfaDeadlineText(status.deadline)}.` : ''
                }`}
        </p>
      )}
      {locked && (
        <p className="text-[var(--warning)]">
          Two-step verification is locked after too many wrong codes. Try again later, or ask an
          administrator to reset it.
        </p>
      )}
    </div>
  );
}

/**
 * Two-step verification for the signed-in person (#399), on Settings → Account
 * (`mode="settings"`: status, authenticator, recovery codes, passkeys) and on
 * the page a limited person is sent to (`mode="setup"`: enrolment only).
 */
export function TwoStepPanel({
  mode,
  onEnrolled,
}: {
  mode: 'settings' | 'setup';
  /** Setting up an authenticator is finished: its recovery codes were saved. */
  onEnrolled?: () => void;
}) {
  const { data: status, isLoading, isError, refetch, isFetching } = useMfaStatus();
  const lock = useReadOnlyLock();
  const [enrolling, setEnrolling] = useState(false);
  const [dialog, setDialog] = useState<ReauthKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (isLoading) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Spinner />
        Loading two-step verification…
      </p>
    );
  }
  if (isError || !status) {
    return (
      <div>
        <p role="alert" className="text-sm text-[var(--danger)]">
          Two-step verification could not be loaded.
        </p>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {isFetching && <Spinner />}
          Try again
        </Button>
      </div>
    );
  }

  // Single sign-on only: the plugin only challenges password sign-in, so a second
  // step here would protect nothing, and the identity provider enforces its own.
  if (!status.eligible) {
    return (
      <div className="text-sm">
        <p className="font-medium text-[var(--text-primary)]">Managed by your organisation</p>
        <p className="mt-1 text-[var(--text-muted)]">
          You sign in through your organisation, which decides how you verify who you are.
        </p>
      </div>
    );
  }

  const hasTotp = status.methods.includes('totp');

  // The enrolment flow outlives the status: confirming turns the second step on, and
  // the recovery codes must stay on screen until the person has saved them.
  if (enrolling) {
    return (
      <TotpEnrol
        onCancel={() => setEnrolling(false)}
        onFinished={() => {
          setEnrolling(false);
          setNotice('The authenticator app is on. You will be asked for a code when you sign in.');
          onEnrolled?.();
        }}
      />
    );
  }

  if (mode === 'setup') {
    // Already set up: the page says to sign in again; nothing is offered here.
    if (status.enrolled) return null;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--text-muted)]">
          Use an authenticator app on your phone, or a password manager that makes codes. You will
          enter a 6-digit code each time you sign in with your password.
        </p>
        <div>
          <Button
            type="button"
            variant="accent"
            locked={lock.title}
            onClick={() => setEnrolling(true)}
          >
            <ShieldCheck />
            Set up an authenticator app
          </Button>
        </div>
      </div>
    );
  }

  const codes =
    status.recoveryCodesLeft === null ? null : recoveryCodesText(status.recoveryCodesLeft);

  return (
    <div className="flex flex-col gap-6">
      <Summary status={status} />
      {notice && (
        <p role="status" className="text-sm text-[var(--success)]">
          {notice}
        </p>
      )}

      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Authenticator app</h3>
        {hasTotp ? (
          <>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              You enter a code from your app each time you sign in with your password.
            </p>
            {codes && (
              <p
                className={
                  codes.low
                    ? 'mt-2 text-sm text-[var(--warning)]'
                    : 'mt-2 text-sm text-[var(--text-secondary)]'
                }
              >
                {codes.text}
                {codes.low && ' Get new ones before you run out.'}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                locked={lock.title}
                onClick={() => setDialog('regenerate')}
              >
                Get new recovery codes
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                locked={lock.title}
                onClick={() => setDialog('disable')}
              >
                Turn off
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Use an authenticator app on your phone, or a password manager that makes codes. You
              will enter a 6-digit code each time you sign in with your password.
            </p>
            <div className="mt-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                locked={lock.title}
                onClick={() => {
                  setNotice(null);
                  setEnrolling(true);
                }}
              >
                Set up an authenticator app
              </Button>
            </div>
          </>
        )}
      </div>

      <PasskeySection passkeys={status.passkeys} onNotice={setNotice} />

      {dialog && (
        <ReauthDialog
          kind={dialog}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          onDone={setNotice}
        />
      )}
    </div>
  );
}
