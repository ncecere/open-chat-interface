import type { MfaStatus } from '@oci/shared';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { PasskeySection } from '~/components/mfa/passkeys';
import { ReauthDialog, type ReauthKind } from '~/components/mfa/reauth-dialog';
import { TotpEnrol } from '~/components/mfa/totp-enrol';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { type Translate, useT } from '~/lib/i18n';
import { mfaDeadlineText, useMfaStatus } from '~/lib/mfa';
import { useReadOnlyLock } from '~/lib/read-only';

/** The recovery codes still unused, said plainly, with a warning when they run low. */
function recoveryCodesText(left: number, t: Translate): { text: string; low: boolean } {
  const low = left <= 2;
  return {
    text: t(low ? 'auth.twoStep.recoveryLeftLow' : 'auth.twoStep.recoveryLeft', { count: left }),
    low,
  };
}

function Summary({ status }: { status: MfaStatus }) {
  const t = useT();
  const parts: string[] = [];
  if (status.methods.includes('totp')) parts.push(t('auth.twoStep.authenticatorApp'));
  const passkeys = status.passkeys.length;
  if (passkeys > 0) parts.push(t('auth.twoStep.passkeyCount', { count: passkeys }));
  const locked = status.lockedUntil && Date.parse(status.lockedUntil) > Date.now();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-[var(--text-secondary)]">
        {t('auth.twoStep.status')}{' '}
        <Badge variant={status.enrolled ? 'success' : 'neutral'}>
          {status.enrolled ? t('auth.twoStep.statusOn') : t('auth.twoStep.statusOff')}
        </Badge>
        {status.enrolled && parts.length > 0 && (
          <span className="ms-2 text-[var(--text-muted)]">{parts.join(' · ')}</span>
        )}
      </p>
      {status.required && (
        <p className="text-[var(--text-secondary)]">
          {status.limited
            ? t('auth.twoStep.requiredLimited')
            : status.enrolled || !status.deadline
              ? t('auth.twoStep.requiredEnrolled')
              : t('auth.twoStep.requiredByDate', { date: mfaDeadlineText(status.deadline) })}
        </p>
      )}
      {locked && <p className="text-[var(--warning)]">{t('auth.twoStep.locked')}</p>}
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
  const t = useT();
  const { data: status, isLoading, isError, refetch, isFetching } = useMfaStatus();
  const lock = useReadOnlyLock();
  const [enrolling, setEnrolling] = useState(false);
  const [dialog, setDialog] = useState<ReauthKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (isLoading) {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <Spinner />
        {t('auth.twoStep.loading')}
      </p>
    );
  }
  if (isError || !status) {
    return (
      <div>
        <p role="alert" className="text-sm text-[var(--danger)]">
          {t('auth.twoStep.loadFailed')}
        </p>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          {isFetching && <Spinner />}
          {t('auth.common.tryAgain')}
        </Button>
      </div>
    );
  }

  // Single sign-on only: the plugin only challenges password sign-in, so a second
  // step here would protect nothing, and the identity provider enforces its own.
  if (!status.eligible) {
    return (
      <div className="text-sm">
        <p className="font-medium text-[var(--text-primary)]">{t('auth.twoStep.managed')}</p>
        <p className="mt-1 text-[var(--text-muted)]">{t('auth.twoStep.managedBody')}</p>
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
          setNotice(t('auth.twoStep.enrolled'));
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
        <p className="text-sm text-[var(--text-muted)]">{t('auth.twoStep.enrolIntro')}</p>
        <div>
          <Button
            type="button"
            variant="accent"
            locked={lock.title}
            onClick={() => setEnrolling(true)}
          >
            <ShieldCheck />
            {t('auth.twoStep.setUpApp')}
          </Button>
        </div>
      </div>
    );
  }

  const codes =
    status.recoveryCodesLeft === null ? null : recoveryCodesText(status.recoveryCodesLeft, t);

  return (
    <div className="flex flex-col gap-6">
      <Summary status={status} />
      {notice && (
        <p role="status" className="text-sm text-[var(--success)]">
          {notice}
        </p>
      )}

      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          {t('auth.twoStep.authenticatorApp')}
        </h3>
        {hasTotp ? (
          <>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {t('auth.twoStep.authenticatorDescription')}
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
                {t('auth.twoStep.getNewCodes')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                locked={lock.title}
                onClick={() => setDialog('disable')}
              >
                {t('auth.twoStep.turnOff')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{t('auth.twoStep.enrolIntro')}</p>
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
                {t('auth.twoStep.setUpApp')}
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
