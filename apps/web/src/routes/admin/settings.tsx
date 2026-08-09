import { type InstanceSettings, instanceSettingsSchema } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AdminPageHeader } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { cn } from '~/lib/utils';
import { AuthenticationSettingsForm } from './settings/authentication-settings';
import { GeneralSettings } from './settings/general-settings';
import { SmtpSettingsForm } from './settings/smtp-settings';

function authSettingsFromResponse(settings: InstanceSettings) {
  return {
    registrationMode: settings.registrationMode,
    emailVerificationRequired: settings.emailVerificationRequired,
    localAuthEnabled: settings.localAuthEnabled,
    sessionLifetimeDays: settings.sessionLifetimeDays,
    sessionRefreshDays: settings.sessionRefreshDays,
  };
}

function LoadingSettings() {
  return (
    <div
      className="mt-8 flex max-w-4xl flex-col gap-6"
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

const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'authentication', label: 'Authentication' },
  { id: 'email', label: 'Email & SMTP' },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];

export function AdminSettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: async () => instanceSettingsSchema.parse(await api.get<unknown>('/admin/settings')),
  });

  return (
    <div className="mx-auto w-full max-w-4xl">
      <AdminPageHeader
        title="Instance settings"
        description="Manage authentication, default model behavior, optional features, and email delivery."
      />

      {settings.isLoading ? (
        <LoadingSettings />
      ) : settings.isError || !settings.data ? (
        <div className="max-w-3xl rounded-xl border border-[var(--border-subtle)] p-5">
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
        <div>
          <div
            className="inline-flex flex-wrap gap-1 rounded-xl bg-[var(--bg-segment-track)] p-1"
            role="tablist"
            aria-label="Instance settings sections"
          >
            {SETTINGS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`admin-settings-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm transition-colors',
                  activeTab === tab.id
                    ? 'bg-[var(--bg-segment-active)] font-medium text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="mt-8 pb-10">
            <div id="admin-settings-general" role="tabpanel" hidden={activeTab !== 'general'}>
              <GeneralSettings settings={settings.data} />
            </div>

            <section
              id="admin-settings-authentication"
              role="tabpanel"
              hidden={activeTab !== 'authentication'}
              aria-labelledby="authentication-heading"
            >
              <div className="mb-4">
                <h2 id="authentication-heading" className="text-lg font-semibold">
                  Authentication
                </h2>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  Manage account registration and sign-in requirements for this instance.
                </p>
              </div>
              <AuthenticationSettingsForm
                initialSettings={authSettingsFromResponse(settings.data)}
                smtpConfigured={settings.data.smtp.configured}
              />
            </section>

            <section
              id="admin-settings-email"
              role="tabpanel"
              hidden={activeTab !== 'email'}
              aria-labelledby="smtp-heading"
            >
              <div className="mb-4">
                <h2 id="smtp-heading" className="text-lg font-semibold">
                  Email delivery
                </h2>
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  Configure SMTP for verification, password reset, and invitation email flows.
                </p>
              </div>
              <SmtpSettingsForm initialSettings={settings.data.smtp} />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
