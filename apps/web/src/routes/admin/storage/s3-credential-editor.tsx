import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import type { StorageSettingsController } from './use-storage-settings';

export function S3CredentialEditor({
  controller,
}: {
  controller: Pick<
    StorageSettingsController,
    | 'saved'
    | 'credentialAction'
    | 'setCredentialAction'
    | 'secretAccessKey'
    | 'setSecretAccessKey'
    | 'showValidation'
    | 'validation'
    | 'save'
    | 'beginEdit'
  >;
}) {
  const {
    saved,
    credentialAction,
    setCredentialAction,
    secretAccessKey,
    setSecretAccessKey,
    showValidation,
    validation,
    save,
    beginEdit,
  } = controller;

  // Each problem is shown under its field, in error colour, which is marked
  // invalid and described by it, not in place of the hint (#302).
  const fieldError = (message?: string) => (showValidation && message) || null;

  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">
            {saved.s3.hasCredential
              ? 'Secret access key configured'
              : 'No secret access key configured'}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Blank input is never sent and keeps an existing credential unchanged.
          </p>
        </div>
        {saved.s3.hasCredential && credentialAction === 'keep' && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                beginEdit();
                setCredentialAction('replace');
              }}
            >
              Replace
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                beginEdit();
                setSecretAccessKey('');
                setCredentialAction('clear');
              }}
            >
              Clear
            </Button>
          </div>
        )}
      </div>

      {(credentialAction === 'replace' || !saved.s3.hasCredential) && (
        <Field
          label={saved.s3.hasCredential ? 'Replacement secret access key' : 'Secret access key'}
          htmlFor="s3-secret-access-key"
          error={fieldError(validation.secretAccessKey)}
          hint={'Leave blank to keep the stored value. Use Clear for explicit removal.'}
        >
          <Input
            id="s3-secret-access-key"
            type="password"
            value={secretAccessKey}
            maxLength={2_049}
            autoComplete="new-password"
            disabled={save.isPending}
            {...invalidFieldProps('s3-secret-access-key', fieldError(validation.secretAccessKey))}
            onChange={(event) => {
              beginEdit();
              setSecretAccessKey(event.target.value);
              setCredentialAction('replace');
            }}
          />
        </Field>
      )}

      {credentialAction === 'clear' && (
        <div role="alert" className="rounded-lg bg-[var(--warning)]/10 p-3 text-sm">
          <p className="font-medium">The stored secret will be cleared when you save.</p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-1 h-auto p-0"
            onClick={() => {
              beginEdit();
              setCredentialAction('keep');
            }}
          >
            Keep existing secret
          </Button>
        </div>
      )}
    </>
  );
}
