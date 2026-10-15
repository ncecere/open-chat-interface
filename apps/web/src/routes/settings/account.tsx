import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useT } from '~/lib/i18n';
import { ChangePasswordDialog, PasswordControl } from './account/change-password';
import { DeleteAccountSection } from './account/delete-account-section';
import { DevicesDialog } from './account/devices-dialog';
import { NameRow } from './account/name-row';
import { TwoStepVerification } from './account/two-step';

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </section>
  );
}

function Row({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export function SettingsAccountPage() {
  const t = useT();
  const { data } = useCurrentUser();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const signIn = data?.signIn;
  const viaOrganisation = (signIn?.sso.length ?? 0) > 0;
  // A name set by an organisation's sign-in is not edited here.
  const nameEditable = Boolean(signIn?.credential) && !viaOrganisation;

  return (
    <div>
      <h1 className="text-2xl font-bold">{t('settings.account.title')}</h1>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{t('settings.account.subtitle')}</p>

      <Section title={t('settings.account.profile')} className="mt-8">
        <div className="flex flex-col gap-3 text-sm">
          {data && <NameRow name={data.user.name} editable={nameEditable} />}
          {data && !nameEditable && viaOrganisation && (
            <p className="-mt-2 text-xs text-[var(--text-muted)]">
              {t('settings.account.nameNoteSso')}
            </p>
          )}
          <div className="flex justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
            <span className="text-[var(--text-muted)]">{t('settings.account.email')}</span>
            <span className="min-w-0 text-end">
              <span className="block [overflow-wrap:anywhere] text-[var(--text-primary)]">
                {data?.user.email}
              </span>
              {viaOrganisation && (
                <span className="block text-xs text-[var(--text-muted)]">
                  {t('settings.account.emailManaged')}
                </span>
              )}
            </span>
          </div>
          <div className="flex justify-between border-b border-[var(--border-subtle)] pb-3">
            <span className="text-[var(--text-muted)]">{t('settings.account.role')}</span>
            <span className="capitalize text-[var(--text-primary)]">{data?.user.role}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--text-muted)]">{t('settings.account.emailVerified')}</span>
            <span className="text-[var(--text-primary)]">
              {data?.user.emailVerified ? t('settings.account.yes') : t('settings.account.no')}
            </span>
          </div>
        </div>
      </Section>

      <Section title={t('settings.account.security')} className="mt-12">
        <Row
          label={t('settings.account.password')}
          description={t('settings.account.passwordDescription')}
        >
          <PasswordControl onChange={() => setPasswordOpen(true)} />
        </Row>

        <TwoStepVerification />

        <Row
          label={t('settings.account.devices')}
          description={t('settings.account.devicesDescription')}
        >
          <Button variant="secondary" size="sm" onClick={() => setDevicesOpen(true)}>
            {t('settings.account.viewDevices')}
          </Button>
        </Row>
      </Section>

      <DeleteAccountSection />

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <DevicesDialog open={devicesOpen} onOpenChange={setDevicesOpen} />
    </div>
  );
}
