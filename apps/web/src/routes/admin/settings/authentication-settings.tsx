import type { InstanceSettings } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Notice, SaveRow, SettingsSection, ToggleSetting } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { ApiError, api } from '~/lib/api-client';

type AuthSettings = Pick<
  InstanceSettings,
  | 'registrationMode'
  | 'emailVerificationRequired'
  | 'localAuthEnabled'
  | 'sessionLifetimeDays'
  | 'sessionRefreshDays'
>;
type AuthSettingsPatch = Partial<AuthSettings>;

const REGISTRATION_DESCRIPTIONS: Record<AuthSettings['registrationMode'], string> = {
  open: 'Anyone can create an account from the sign-up page.',
  invite_only: 'Only people with a valid invitation can create an account.',
  closed: 'New accounts cannot be created through the sign-up page.',
};

function changedSettings(saved: AuthSettings, draft: AuthSettings): AuthSettingsPatch {
  const patch: AuthSettingsPatch = {};

  if (saved.registrationMode !== draft.registrationMode) {
    patch.registrationMode = draft.registrationMode;
  }
  if (saved.emailVerificationRequired !== draft.emailVerificationRequired) {
    patch.emailVerificationRequired = draft.emailVerificationRequired;
  }
  if (saved.localAuthEnabled !== draft.localAuthEnabled) {
    patch.localAuthEnabled = draft.localAuthEnabled;
  }
  if (saved.sessionLifetimeDays !== draft.sessionLifetimeDays) {
    patch.sessionLifetimeDays = draft.sessionLifetimeDays;
  }
  if (saved.sessionRefreshDays !== draft.sessionRefreshDays) {
    patch.sessionRefreshDays = draft.sessionRefreshDays;
  }

  return patch;
}

export function AuthenticationSettingsForm({
  initialSettings,
  smtpConfigured,
}: {
  initialSettings: AuthSettings;
  smtpConfigured: boolean;
}) {
  const queryClient = useQueryClient();
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [draft, setDraft] = useState(initialSettings);
  const [showLocalAuthWarning, setShowLocalAuthWarning] = useState(false);
  const [savedMessage, setSavedMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const patch = changedSettings(savedSettings, draft);
  const hasChanges = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: (changes: AuthSettingsPatch) =>
      api.patch<{ ok: boolean }>('/admin/settings', changes),
    onSuccess: (_response, changes) => {
      setSavedSettings((current) => ({ ...current, ...changes }));
      setErrorMessage(null);
      setSavedMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, ...changes } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
    },
    onError: (error) => {
      setSavedMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save authentication settings.',
      );
    },
  });

  function beginEdit() {
    setSavedMessage(false);
    setErrorMessage(null);
    save.reset();
  }

  function setRegistrationMode(registrationMode: AuthSettings['registrationMode']) {
    beginEdit();
    setDraft((current) => ({ ...current, registrationMode }));
  }

  function setBooleanSetting(
    setting: 'emailVerificationRequired' | 'localAuthEnabled',
    value: boolean,
  ) {
    beginEdit();
    setDraft((current) => ({ ...current, [setting]: value }));
  }

  return (
    <>
      <form
        className="flex flex-col gap-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (hasChanges) save.mutate(patch);
        }}
      >
        <SettingsSection
          title="Account registration"
          description="Control who can create a new account on this instance."
        >
          <Field
            label="Registration mode"
            htmlFor="registration-mode"
            hint={REGISTRATION_DESCRIPTIONS[draft.registrationMode]}
          >
            <Select
              id="registration-mode"
              value={draft.registrationMode}
              disabled={save.isPending}
              onChange={(next) => setRegistrationMode(next as AuthSettings['registrationMode'])}
              options={[
                { value: 'open', label: 'Open registration' },
                { value: 'invite_only', label: 'Invite only' },
                { value: 'closed', label: 'Closed' },
              ]}
            />
          </Field>
        </SettingsSection>

        <SettingsSection
          title="Sign-in security"
          description="Configure email and password authentication for this instance."
        >
          <div className="divide-y divide-[var(--border-subtle)]">
            <ToggleSetting
              id="email-verification-required"
              label="Require email verification"
              description="New local accounts must verify their email address before they can sign in. Make sure email delivery is configured before enabling this."
              checked={draft.emailVerificationRequired}
              disabled={save.isPending}
              onCheckedChange={(checked) => setBooleanSetting('emailVerificationRequired', checked)}
            />
            <ToggleSetting
              id="local-auth-enabled"
              label="Allow email and password sign-in"
              description="Allow people to sign in using credentials stored by this instance. Disable this only when another authentication method is available."
              checked={draft.localAuthEnabled}
              disabled={save.isPending}
              onCheckedChange={(checked) => {
                if (checked) {
                  setBooleanSetting('localAuthEnabled', true);
                } else {
                  setShowLocalAuthWarning(true);
                }
              }}
            />
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Field
              label="Session length (days)"
              htmlFor="session-lifetime"
              hint="How long somebody stays signed in. Shortening this does not end sessions already issued; those keep their original expiry."
            >
              <Input
                id="session-lifetime"
                type="number"
                min={1}
                max={365}
                value={draft.sessionLifetimeDays}
                disabled={save.isPending}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    sessionLifetimeDays: Number(event.target.value),
                  }))
                }
              />
            </Field>

            <Field
              label="Extend after (days)"
              htmlFor="session-refresh"
              hint="How much of the session must elapse before activity extends it again."
            >
              <Input
                id="session-refresh"
                type="number"
                min={1}
                max={365}
                value={draft.sessionRefreshDays}
                disabled={save.isPending}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    sessionRefreshDays: Number(event.target.value),
                  }))
                }
              />
            </Field>
          </div>
        </SettingsSection>

        {draft.sessionRefreshDays > draft.sessionLifetimeDays && (
          <Notice tone="warning" title="Sessions will never be extended">
            The extension threshold is longer than the session itself, so a session will expire
            before activity can renew it. People will be signed out on a fixed schedule regardless
            of use.
          </Notice>
        )}

        {draft.emailVerificationRequired && !smtpConfigured && (
          <Notice tone="warning" title="Email delivery is not configured">
            Verification remains required even when email delivery is unavailable. Unverified
            accounts cannot sign in until delivery is restored and they verify their address.
            Configure and test email delivery before enabling this requirement.
          </Notice>
        )}

        {!draft.localAuthEnabled && (
          <Notice tone="warning" title="Local authentication is off">
            Email and password sign-in is unavailable. Confirm that admins and users can sign in
            another way before leaving this page.
          </Notice>
        )}

        <SaveRow
          hasChanges={hasChanges}
          isPending={save.isPending}
          errorMessage={errorMessage}
          successMessage={savedMessage ? 'Authentication settings saved.' : null}
        />
      </form>

      <Dialog open={showLocalAuthWarning} onOpenChange={setShowLocalAuthWarning}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable email and password sign-in?</DialogTitle>
            <DialogDescription>
              This can lock users and administrators out of the instance. Before continuing, verify
              that another authentication method is configured and working.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm text-[var(--text-secondary)]">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-[var(--warning)]"
              aria-hidden="true"
            />
            Saving this change will prevent all email and password sign-ins.
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setShowLocalAuthWarning(false)}>
              Keep local sign-in enabled
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setBooleanSetting('localAuthEnabled', false);
                setShowLocalAuthWarning(false);
              }}
            >
              Disable local sign-in
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
