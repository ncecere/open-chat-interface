import { type InstanceSettings, instanceSettingsSchema } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AdminPageHeader, Notice } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { useSetupCheck } from '~/hooks/use-setup-status';
import { ApiError, api } from '~/lib/api-client';
import { SsoProvidersSection } from '~/routes/admin/sso';
import { AuthenticationSettingsForm } from './settings/authentication-settings';
import { GeneralSettings } from './settings/general-settings';
import { SmtpSettingsForm } from './settings/smtp-settings';

function authSettingsFromResponse(settings: InstanceSettings) {
  return {
    registrationMode: settings.registrationMode,
    emailVerificationRequired: settings.emailVerificationRequired,
    localAuthEnabled: settings.localAuthEnabled,
    sessionLifetimeDays: settings.sessionLifetimeDays,
  };
}

function LoadingSettings() {
  return (
    <div
      className="flex flex-col gap-6"
      aria-busy="true"
      aria-label="Loading instance settings"
      role="status"
    >
      <div className="flex items-center gap-3 text-sm text-[var(--text-muted)]">
        <Spinner />
        Loading instance settings…
      </div>
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="animate-pulse border-t border-[var(--border-subtle)] pt-5">
          <div className="h-4 w-40 rounded bg-[var(--bg-control-hover)]" />
          <div className="mt-2 h-3 w-3/4 rounded bg-[var(--bg-control-hover)]" />
        </div>
      ))}
    </div>
  );
}

/** One query shared by the three settings pages, so moving between them is instant. */
export function useInstanceSettings() {
  return useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => instanceSettingsSchema.parse(await api.get<unknown>('/admin/settings')),
  });
}

/**
 * The frame every instance-settings page shares: its own heading, then the
 * loading and error states, then the page's form once settings are available.
 */
function InstanceSettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: (settings: InstanceSettings) => ReactNode;
}) {
  const settings = useInstanceSettings();

  return (
    <div className="pb-10">
      <AdminPageHeader title={title} description={description} />

      {settings.isLoading ? (
        <LoadingSettings />
      ) : settings.isError || !settings.data ? (
        <div className="rounded-xl border border-[var(--border-subtle)] p-5">
          <p role="alert" className="text-sm text-[var(--danger)]">
            {settings.error instanceof ApiError
              ? settings.error.message
              : 'Unable to load instance settings.'}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4"
            disabled={settings.isFetching}
            onClick={() => settings.refetch()}
          >
            {settings.isFetching && <Spinner />}
            Try again
          </Button>
        </div>
      ) : (
        children(settings.data)
      )}
    </div>
  );
}

export function AdminGeneralSettingsPage() {
  return (
    <InstanceSettingsPage
      title="General"
      description="The default system prompt and optional chat features."
    >
      {(settings) => <GeneralSettings settings={settings} />}
    </InstanceSettingsPage>
  );
}

/**
 * Sign-in problems from the server's checklist, which this page resolves. A
 * missing email server is already explained beside the verification setting,
 * with a link to Email delivery, so it is not repeated here.
 */
function AuthenticationSetupNotices() {
  const signIn = useSetupCheck('sign-in');
  if (signIn?.status !== 'attention') return null;

  return (
    <div className="mb-8">
      <Notice tone="warning" title="Nobody can sign in">
        {signIn.detail} Allow email and password sign-in below, or enable a single sign-on provider.
      </Notice>
    </div>
  );
}

export function AdminAuthenticationSettingsPage() {
  return (
    <InstanceSettingsPage
      title="Authentication"
      description="Who can register, every way people sign in — local accounts and single sign-on — and how long sessions last."
    >
      {(settings) => (
        <>
          <AuthenticationSetupNotices />
          <div className="flex flex-col gap-8">
            <AuthenticationSettingsForm
              initialSettings={authSettingsFromResponse(settings)}
              smtpConfigured={settings.smtp.configured}
            />
            <SsoProvidersSection />
          </div>
        </>
      )}
    </InstanceSettingsPage>
  );
}

export function AdminEmailSettingsPage() {
  return (
    <InstanceSettingsPage
      title="Email delivery"
      description="SMTP for verification, password reset, and invitation email."
    >
      {(settings) => <SmtpSettingsForm initialSettings={settings.smtp} />}
    </InstanceSettingsPage>
  );
}
