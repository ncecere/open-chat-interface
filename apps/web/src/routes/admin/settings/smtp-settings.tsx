import type { InstanceSettings } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  MutationError,
  Notice,
  SaveRow,
  SettingsSection,
  ToggleSetting,
} from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { api, apiErrorMessage } from '~/lib/api-client';
import { cn } from '~/lib/utils';

type SmtpSettings = InstanceSettings['smtp'];
type CredentialAction = 'keep' | 'replace' | 'clear';
type SmtpPatch = Partial<Omit<SmtpSettings, 'configured'>> & {
  username?: string | null;
  password?: string | null;
};

interface SmtpDraft {
  host: string;
  port: string;
  secure: boolean;
  fromAddress: string;
}

interface SmtpErrors {
  host?: string;
  port?: string;
  fromAddress?: string;
  username?: string;
  password?: string;
}

function makeDraft(settings: SmtpSettings): SmtpDraft {
  return {
    host: settings.host ?? '',
    port: settings.port === null ? '' : String(settings.port),
    secure: settings.secure,
    fromAddress: settings.fromAddress ?? '',
  };
}

function configuredFrom(settings: Pick<SmtpSettings, 'host' | 'port' | 'fromAddress'>) {
  return Boolean(settings.host && settings.port && settings.fromAddress);
}

function validateDraft(
  draft: SmtpDraft,
  usernameAction: CredentialAction,
  username: string,
  passwordAction: CredentialAction,
  password: string,
): SmtpErrors {
  const errors: SmtpErrors = {};
  const host = draft.host.trim();
  const fromAddress = draft.fromAddress.trim();
  const port = draft.port.trim() ? Number(draft.port) : null;
  const hasAnyDeliveryField = Boolean(host || fromAddress || port !== null);

  if (hasAnyDeliveryField) {
    if (!host) errors.host = 'Enter an SMTP host, or clear every delivery field to disable SMTP.';
    if (port === null) errors.port = 'Enter an SMTP port.';
    if (!fromAddress) errors.fromAddress = 'Enter a from address.';
  }

  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    errors.port = 'Port must be a whole number from 1 to 65535.';
  }

  if (usernameAction === 'replace' && username.length > 200) {
    errors.username = 'The username must be 200 characters or fewer.';
  }
  if (passwordAction === 'replace' && password.length > 500) {
    errors.password = 'The password must be 500 characters or fewer.';
  }

  return errors;
}

function changedSmtpSettings(
  saved: SmtpSettings,
  draft: SmtpDraft,
  usernameAction: CredentialAction,
  username: string,
  passwordAction: CredentialAction,
  password: string,
): SmtpPatch {
  const patch: SmtpPatch = {};
  const host = draft.host.trim() || null;
  const fromAddress = draft.fromAddress.trim() || null;
  const parsedPort = draft.port.trim() ? Number(draft.port) : null;

  if (saved.host !== host) patch.host = host;
  if (saved.port !== parsedPort && (parsedPort === null || Number.isInteger(parsedPort))) {
    patch.port = parsedPort;
  }
  if (saved.secure !== draft.secure) patch.secure = draft.secure;
  if (saved.fromAddress !== fromAddress) patch.fromAddress = fromAddress;

  if (usernameAction === 'clear') patch.username = null;
  if (usernameAction === 'replace' && username.trim()) patch.username = username.trim();
  if (passwordAction === 'clear') patch.password = null;
  if (passwordAction === 'replace' && password) patch.password = password;

  return patch;
}

function CredentialEditor({
  kind,
  stored,
  action,
  value,
  error,
  disabled,
  onActionChange,
  onValueChange,
}: {
  kind: 'username' | 'password';
  /** Whether one is stored, as the server reports (#115). */
  stored?: boolean;
  action: CredentialAction;
  value: string;
  error?: string;
  disabled: boolean;
  onActionChange: (action: CredentialAction) => void;
  onValueChange: (value: string) => void;
}) {
  const label = kind === 'username' ? 'SMTP username' : 'SMTP password';
  const maxLength = kind === 'username' ? 201 : 501;

  return (
    <div className="rounded-lg border border-[var(--border-subtle)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            {stored === undefined
              ? `Keep leaves any stored ${kind} unchanged.`
              : stored
                ? `A ${kind} is stored. Keep leaves it unchanged.`
                : `No ${kind} is stored.`}
          </p>
        </div>
        {action === 'keep' && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              // Username and password each have these; the name says which (#260).
              aria-label={`Set or replace the ${label}`}
              onClick={() => onActionChange('replace')}
            >
              Set or replace
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              aria-label={`Clear stored value of the ${label}`}
              onClick={() => onActionChange('clear')}
            >
              Clear stored value
            </Button>
          </div>
        )}
      </div>

      {action === 'replace' && (
        <div className="mt-4">
          <Field
            label={`Replacement ${kind}`}
            htmlFor={`smtp-${kind}`}
            hint={
              error ??
              `A blank field is not sent and will not clear an existing ${kind}. Maximum ${maxLength - 1} characters.`
            }
          >
            <Input
              id={`smtp-${kind}`}
              type={kind === 'password' ? 'password' : 'text'}
              value={value}
              maxLength={maxLength}
              autoComplete={kind === 'password' ? 'new-password' : 'username'}
              disabled={disabled}
              aria-invalid={Boolean(error)}
              onChange={(event) => onValueChange(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            size="sm"
            variant="link"
            className="mt-2 h-auto p-0"
            disabled={disabled}
            aria-label={`Keep stored value instead for the ${label}`}
            onClick={() => onActionChange('keep')}
          >
            Keep stored value instead
          </Button>
        </div>
      )}

      {action === 'clear' && (
        <div role="alert" className="mt-4 rounded-lg bg-[var(--warning)]/10 p-3 text-sm">
          <p className="font-medium">The stored {kind} will be cleared when you save.</p>
          <Button
            type="button"
            size="sm"
            variant="link"
            className="mt-1 h-auto p-0"
            disabled={disabled}
            aria-label={`Keep stored value of the ${label}`}
            onClick={() => onActionChange('keep')}
          >
            Keep stored value
          </Button>
        </div>
      )}
    </div>
  );
}

export function SmtpSettingsForm({ initialSettings }: { initialSettings: SmtpSettings }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initialSettings);
  const [draft, setDraft] = useState(() => makeDraft(initialSettings));
  const [usernameAction, setUsernameAction] = useState<CredentialAction>('keep');
  const [username, setUsername] = useState('');
  const [passwordAction, setPasswordAction] = useState<CredentialAction>('keep');
  const [password, setPassword] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const errors = validateDraft(draft, usernameAction, username, passwordAction, password);
  const isValid = Object.keys(errors).length === 0;
  const patch = changedSmtpSettings(
    saved,
    draft,
    usernameAction,
    username,
    passwordAction,
    password,
  );
  const hasChanges = Object.keys(patch).length > 0;
  useReportUnsaved(hasChanges);
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/admin/settings/smtp/test', {}),
  });
  const testBlocked = hasChanges
    ? 'Save changes before testing them.'
    : !saved.configured
      ? 'Save a host, port and From address first.'
      : null;

  const save = useMutation({
    mutationFn: (smtp: SmtpPatch) => api.patch<{ ok: boolean }>('/admin/settings', { smtp }),
    onSuccess: (_response, changes) => {
      const { username: _username, password: _password, ...visibleChanges } = changes;
      const nextVisible = { ...saved, ...visibleChanges };
      const next: SmtpSettings = {
        ...nextVisible,
        configured: configuredFrom(nextVisible),
        // A replaced credential is now stored, a cleared one is not.
        hasUsername:
          'username' in changes ? Boolean(changes.username) : (saved.hasUsername ?? undefined),
        hasPassword:
          'password' in changes ? Boolean(changes.password) : (saved.hasPassword ?? undefined),
      };

      setSaved(next);
      setDraft(makeDraft(next));
      setUsernameAction('keep');
      setUsername('');
      setPasswordAction('keep');
      setPassword('');
      setShowValidation(false);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, smtp: next } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
      void queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY });
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(apiErrorMessage(error, 'Unable to save SMTP settings.'));
    },
  });

  function beginEdit() {
    setErrorMessage(null);
    setSuccessMessage(false);
  }

  function setCredentialAction(kind: 'username' | 'password', action: CredentialAction) {
    beginEdit();
    if (kind === 'username') {
      setUsernameAction(action);
      if (action !== 'replace') setUsername('');
    } else {
      setPasswordAction(action);
      if (action !== 'replace') setPassword('');
    }
  }

  return (
    <form
      className="flex flex-col gap-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setShowValidation(true);
        if (isValid && hasChanges) save.mutate(patch);
      }}
    >
      <SettingsSection
        title={saved.configured ? 'SMTP configuration present' : 'SMTP not configured'}
        description="Status is derived from a saved host, port, and from address. It is not a connection or delivery test."
      >
        <Notice
          tone={saved.configured ? 'info' : 'warning'}
          title={
            saved.configured
              ? 'Required SMTP fields are saved'
              : 'Verification, reset, and invitation emails need SMTP'
          }
        >
          Saving a complete configuration changes the status reported to the sign-in experience. Use{' '}
          <strong>Send test email</strong> below to confirm messages arrive before requiring email
          verification.
        </Notice>
      </SettingsSection>

      <SettingsSection
        title="Delivery server"
        description="Enter all delivery fields to configure SMTP, or clear host, port, and from address to disable it."
      >
        <div className="flex flex-col gap-5">
          <Field
            label="SMTP host"
            htmlFor="smtp-host"
            hint={showValidation && errors.host ? errors.host : 'For example, smtp.example.com.'}
          >
            <Input
              id="smtp-host"
              value={draft.host}
              placeholder="smtp.example.com"
              disabled={save.isPending}
              aria-invalid={showValidation && Boolean(errors.host)}
              onChange={(event) => {
                beginEdit();
                setDraft((current) => ({ ...current, host: event.target.value }));
              }}
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Port"
              htmlFor="smtp-port"
              hint={showValidation && errors.port ? errors.port : 'Commonly 465 or 587.'}
            >
              <Input
                id="smtp-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65_535}
                step={1}
                value={draft.port}
                disabled={save.isPending}
                aria-invalid={showValidation && Boolean(errors.port)}
                onChange={(event) => {
                  beginEdit();
                  setDraft((current) => ({ ...current, port: event.target.value }));
                }}
              />
            </Field>

            <Field
              label="From address"
              htmlFor="smtp-from-address"
              hint={
                showValidation && errors.fromAddress
                  ? errors.fromAddress
                  : 'Mailbox value shown as the sender of system email.'
              }
            >
              <Input
                id="smtp-from-address"
                type="text"
                value={draft.fromAddress}
                placeholder="noreply@example.com"
                disabled={save.isPending}
                aria-invalid={showValidation && Boolean(errors.fromAddress)}
                onChange={(event) => {
                  beginEdit();
                  setDraft((current) => ({ ...current, fromAddress: event.target.value }));
                }}
              />
            </Field>
          </div>

          <div className="rounded-lg border border-[var(--border-subtle)] px-4">
            <ToggleSetting
              id="smtp-secure"
              label="Use implicit TLS"
              description="Enable for TLS from connection start, commonly on port 465. Leave off for STARTTLS-style connections such as port 587."
              checked={draft.secure}
              disabled={save.isPending}
              onCheckedChange={(secure) => {
                beginEdit();
                setDraft((current) => ({ ...current, secure }));
              }}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Authentication credentials"
        description="Passwords are encrypted when written. Neither usernames nor passwords are returned by the settings API, and saving delivery fields preserves stored values."
      >
        <div className="flex flex-col gap-4">
          <CredentialEditor
            kind="username"
            stored={saved.hasUsername}
            action={usernameAction}
            value={username}
            error={showValidation ? errors.username : undefined}
            disabled={save.isPending}
            onActionChange={(action) => setCredentialAction('username', action)}
            onValueChange={(value) => {
              beginEdit();
              setUsername(value);
            }}
          />
          <CredentialEditor
            kind="password"
            stored={saved.hasPassword}
            action={passwordAction}
            value={password}
            error={showValidation ? errors.password : undefined}
            disabled={save.isPending}
            onActionChange={(action) => setCredentialAction('password', action)}
            onValueChange={(value) => {
              beginEdit();
              setPassword(value);
            }}
          />
        </div>
      </SettingsSection>

      <SaveRow
        hasChanges={hasChanges}
        isPending={save.isPending}
        errorMessage={errorMessage}
        successMessage={successMessage ? 'SMTP settings saved.' : null}
      />

      {/* Configure, then test (#115): Authentication links here for both. */}
      <SettingsSection
        title="Test delivery"
        description="Sends a short message to your own address with the saved settings, and shows the mail server's answer if it fails."
      >
        <div className="flex flex-col gap-2">
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={testBlocked !== null || test.isPending}
              aria-describedby={testBlocked ? 'smtp-test-blocked' : undefined}
              onClick={() => test.mutate()}
            >
              {test.isPending && <Spinner />}
              Send test email
            </Button>
          </div>
          {testBlocked && (
            <p id="smtp-test-blocked" className="text-xs text-[var(--text-muted)]">
              {testBlocked}
            </p>
          )}
          {test.data && (
            <p
              role="status"
              className={cn(
                'text-sm',
                test.data.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--danger-on-tint)]',
              )}
            >
              {test.data.message}
            </p>
          )}
          <MutationError error={test.error} message="The test email could not be sent." />
        </div>
      </SettingsSection>
    </form>
  );
}
