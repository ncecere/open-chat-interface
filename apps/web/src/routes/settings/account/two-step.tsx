import { TwoStepPanel } from '~/components/mfa/two-step-panel';

/**
 * The "Two-step verification" row of Settings → Account → Security & Access
 * (#399). The same look as the page's other rows; the panel holds the rest.
 */
export function TwoStepVerification() {
  return (
    <div id="two-step-verification">
      <p className="text-sm font-medium text-[var(--text-primary)]">Two-step verification</p>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Ask for a code from your authenticator app, or a passkey, as well as your password when you
        sign in.
      </p>
      <div className="mt-3">
        <TwoStepPanel mode="settings" />
      </div>
    </div>
  );
}
