import { TwoStepPanel } from '~/components/mfa/two-step-panel';
import { useT } from '~/lib/i18n';

/**
 * The "Two-step verification" row of Settings → Account → Security & Access
 * (#399). The same look as the page's other rows; the panel holds the rest.
 */
export function TwoStepVerification() {
  const t = useT();
  return (
    <div id="two-step-verification">
      <p className="text-sm font-medium text-[var(--text-primary)]">
        {t('auth.twoStep.settingsTitle')}
      </p>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        {t('auth.twoStep.settingsDescription')}
      </p>
      <div className="mt-3">
        <TwoStepPanel mode="settings" />
      </div>
    </div>
  );
}
