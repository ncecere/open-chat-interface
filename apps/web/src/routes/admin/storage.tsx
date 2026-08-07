import type { InstanceSettings, StorageDriver, UpdateInstanceSettings } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, HardDrive, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { AdminPageHeader, SettingsSection } from '~/components/admin/admin-ui';
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
import { Input, Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { ApiError, api } from '~/lib/api-client';

type StorageSettings = InstanceSettings['storage'];
type StoragePatch = NonNullable<UpdateInstanceSettings['storage']>;
type S3Patch = NonNullable<StoragePatch['s3']>;
type CredentialAction = 'keep' | 'replace' | 'clear';
type HealthMode = 'read' | 'write';

interface StorageDraft {
  driver: StorageDriver;
  maxFileBytes: string;
  maxFilesPerMessage: string;
  allowedMimeTypes: string;
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  forcePathStyle: boolean;
}

interface StorageValidation {
  maxFileBytes?: string;
  maxFilesPerMessage?: string;
  allowedMimeTypes?: string;
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

function makeDraft(settings: StorageSettings): StorageDraft {
  return {
    driver: settings.driver,
    maxFileBytes: String(settings.maxFileBytes),
    maxFilesPerMessage: String(settings.maxFilesPerMessage),
    allowedMimeTypes: settings.allowedMimeTypes.join('\n'),
    bucket: settings.s3.bucket,
    region: settings.s3.region,
    endpoint: settings.s3.endpoint ?? '',
    accessKeyId: settings.s3.accessKeyId,
    forcePathStyle: settings.s3.forcePathStyle,
  };
}

function parseMimeTypes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((mimeType) => mimeType.trim())
        .filter(Boolean),
    ),
  ];
}

function validateDraft(
  draft: StorageDraft,
  hasSavedCredential: boolean,
  credentialAction: CredentialAction,
  secretAccessKey: string,
): StorageValidation {
  const errors: StorageValidation = {};
  const maxFileBytes = Number(draft.maxFileBytes);
  const maxFilesPerMessage = Number(draft.maxFilesPerMessage);
  const allowedMimeTypes = parseMimeTypes(draft.allowedMimeTypes);
  const willHaveCredential =
    credentialAction === 'replace'
      ? Boolean(secretAccessKey)
      : credentialAction === 'clear'
        ? false
        : hasSavedCredential;

  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    errors.maxFileBytes = 'File size must be a positive whole number of bytes.';
  }
  if (!Number.isSafeInteger(maxFilesPerMessage) || maxFilesPerMessage <= 0) {
    errors.maxFilesPerMessage = 'File count must be a positive whole number.';
  }

  const invalidMimeType = allowedMimeTypes.find((mimeType) => !/^[^\s/]+\/[^\s/]+$/.test(mimeType));
  if (invalidMimeType) {
    errors.allowedMimeTypes = `“${invalidMimeType}” is not a valid MIME type.`;
  }

  if (draft.endpoint.trim()) {
    try {
      const endpoint = new URL(draft.endpoint.trim());
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
        errors.endpoint = 'Endpoint must use HTTP or HTTPS.';
      } else if (endpoint.username || endpoint.password) {
        errors.endpoint = 'Endpoint must not include credentials.';
      }
    } catch {
      errors.endpoint = 'Enter a valid absolute URL.';
    }
  }

  if (secretAccessKey.length > 2_048) {
    errors.secretAccessKey = 'Secret access key must be 2,048 characters or fewer.';
  }

  if (draft.driver === 's3') {
    if (!draft.bucket.trim()) errors.bucket = 'Bucket is required for the S3 driver.';
    if (!draft.region.trim()) errors.region = 'Region is required for the S3 driver.';
    if (!draft.accessKeyId.trim()) {
      errors.accessKeyId = 'Access key ID is required for the S3 driver.';
    }
    if (!willHaveCredential) {
      errors.secretAccessKey = 'A secret access key is required for the S3 driver.';
    }
  }

  return errors;
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function changedStorageSettings(
  saved: StorageSettings,
  draft: StorageDraft,
  credentialAction: CredentialAction,
  secretAccessKey: string,
): StoragePatch {
  const patch: StoragePatch = {};
  const maxFileBytes = Number(draft.maxFileBytes);
  const maxFilesPerMessage = Number(draft.maxFilesPerMessage);
  const allowedMimeTypes = parseMimeTypes(draft.allowedMimeTypes);

  if (saved.driver !== draft.driver) patch.driver = draft.driver;
  if (Number.isSafeInteger(maxFileBytes) && saved.maxFileBytes !== maxFileBytes) {
    patch.maxFileBytes = maxFileBytes;
  }
  if (Number.isSafeInteger(maxFilesPerMessage) && saved.maxFilesPerMessage !== maxFilesPerMessage) {
    patch.maxFilesPerMessage = maxFilesPerMessage;
  }
  if (!sameStrings(saved.allowedMimeTypes, allowedMimeTypes)) {
    patch.allowedMimeTypes = allowedMimeTypes;
  }

  const s3: S3Patch = {};
  const bucket = draft.bucket.trim();
  const region = draft.region.trim();
  const endpoint = draft.endpoint.trim() || null;
  const accessKeyId = draft.accessKeyId.trim();
  if (saved.s3.bucket !== bucket) s3.bucket = bucket;
  if (saved.s3.region !== region) s3.region = region;
  if (saved.s3.endpoint !== endpoint) s3.endpoint = endpoint;
  if (saved.s3.accessKeyId !== accessKeyId) s3.accessKeyId = accessKeyId;
  if (saved.s3.forcePathStyle !== draft.forcePathStyle) {
    s3.forcePathStyle = draft.forcePathStyle;
  }
  if (credentialAction === 'clear' && saved.s3.hasCredential) s3.secretAccessKey = null;
  if (credentialAction === 'replace' && secretAccessKey) {
    s3.secretAccessKey = secretAccessKey;
  }
  if (Object.keys(s3).length > 0) patch.s3 = s3;

  return patch;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
}

function LoadingStorageSettings() {
  return (
    <div
      className="flex max-w-3xl items-center gap-3 text-sm text-[var(--text-muted)]"
      role="status"
      aria-busy="true"
      aria-label="Loading storage settings"
    >
      <Spinner />
      Loading storage settings…
    </div>
  );
}

function DriverWarning({ driver }: { driver: StorageDriver }) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-4 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <div>
        <p className="font-medium text-[var(--text-primary)]">
          Changing to {driver === 's3' ? 'S3' : 'local storage'} does not move existing files
        </p>
        <p className="mt-1 leading-relaxed text-[var(--text-muted)]">
          Reads switch to the selected backend immediately. Migrate existing objects first and keep
          the previous backend recoverable, or existing attachments may become unavailable.
        </p>
      </div>
    </div>
  );
}

function StorageSettingsForm({ initialSettings }: { initialSettings: StorageSettings }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initialSettings);
  const [draft, setDraft] = useState(() => makeDraft(initialSettings));
  const [credentialAction, setCredentialAction] = useState<CredentialAction>('keep');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const [showDriverConfirmation, setShowDriverConfirmation] = useState(false);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [healthMessage, setHealthMessage] = useState<string | null>(null);

  const validation = validateDraft(
    draft,
    saved.s3.hasCredential,
    credentialAction,
    secretAccessKey,
  );
  const isValid = Object.keys(validation).length === 0;
  const patch = changedStorageSettings(saved, draft, credentialAction, secretAccessKey);
  const hasChanges = Object.keys(patch).length > 0;
  const driverChanged = saved.driver !== draft.driver;
  const maxFileBytes = Number(draft.maxFileBytes);

  const save = useMutation({
    mutationFn: (storage: StoragePatch) =>
      api.patch<{ ok: boolean }>('/admin/settings', { storage }),
    onSuccess: (_response, changes) => {
      const { s3: s3Changes, ...topLevelChanges } = changes;
      const { secretAccessKey: credential, ...publicS3Changes } = s3Changes ?? {};
      const next: StorageSettings = {
        ...saved,
        ...topLevelChanges,
        s3: {
          ...saved.s3,
          ...publicS3Changes,
          hasCredential:
            credential === null
              ? false
              : typeof credential === 'string' && credential.length > 0
                ? true
                : saved.s3.hasCredential,
        },
      };
      setSaved(next);
      setDraft(makeDraft(next));
      setCredentialAction('keep');
      setSecretAccessKey('');
      setShowValidation(false);
      setShowDriverConfirmation(false);
      setErrorMessage(null);
      setHealthMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, storage: next } : current,
      );
    },
    onError: (error) => {
      setShowDriverConfirmation(false);
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save storage settings.',
      );
    },
  });

  const health = useMutation({
    mutationFn: (mode: HealthMode) =>
      api.post<{ ok: boolean; mode: HealthMode }>('/admin/settings/storage/test', { mode }),
    onSuccess: (_response, mode) => {
      setErrorMessage(null);
      setHealthMessage(
        mode === 'write'
          ? 'S3 put, read, and delete test succeeded.'
          : 'S3 bucket access check succeeded.',
      );
    },
    onError: (error) => {
      setHealthMessage(null);
      setErrorMessage(error instanceof ApiError ? error.message : 'S3 connection test failed.');
    },
  });

  function beginEdit() {
    setSuccessMessage(false);
    setHealthMessage(null);
    setErrorMessage(null);
  }

  function submitChanges() {
    setShowValidation(true);
    if (!isValid || !hasChanges) return;
    if (driverChanged) {
      setShowDriverConfirmation(true);
      return;
    }
    save.mutate(patch);
  }

  return (
    <>
      <form
        className="flex max-w-3xl flex-col gap-8"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submitChanges();
        }}
      >
        <SettingsSection
          title="Storage driver"
          description="Select where attachments are stored. Invalid S3 settings are never allowed to fall back silently to local storage."
        >
          <div className="flex flex-col gap-5">
            <Field label="Driver" htmlFor="storage-driver">
              <Select
                id="storage-driver"
                value={draft.driver}
                disabled={save.isPending}
                onChange={(event) => {
                  beginEdit();
                  setDraft((current) => ({
                    ...current,
                    driver: event.target.value as StorageDriver,
                  }));
                }}
              >
                <option value="local">Local filesystem</option>
                <option value="s3">S3-compatible object storage</option>
              </Select>
            </Field>

            {driverChanged && <DriverWarning driver={draft.driver} />}

            {draft.driver === 'local' && (
              <div className="flex gap-3 rounded-xl border border-[var(--border-subtle)] p-4 text-sm">
                <HardDrive className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" />
                <div className="min-w-0">
                  <p className="font-medium">Local filesystem path</p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                    The path is deployment-managed and is not exposed by the admin API. Ensure its
                    volume is persistent and backed up.
                  </p>
                </div>
              </div>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          title="S3 connection"
          description="Saved S3 settings can be prepared and tested while local storage remains active."
        >
          <div className="flex flex-col gap-5">
            <div className="flex gap-3 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-4 text-sm">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
              <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                The secret access key is encrypted by the server and is never returned. The bucket,
                endpoint, region, and access key ID are visible to administrators. Saving connection
                details does not migrate files.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Bucket"
                htmlFor="s3-bucket"
                hint={showValidation && validation.bucket ? validation.bucket : undefined}
              >
                <Input
                  id="s3-bucket"
                  value={draft.bucket}
                  maxLength={255}
                  disabled={save.isPending}
                  aria-invalid={showValidation && Boolean(validation.bucket)}
                  onChange={(event) => {
                    beginEdit();
                    setDraft((current) => ({ ...current, bucket: event.target.value }));
                  }}
                />
              </Field>
              <Field
                label="Region"
                htmlFor="s3-region"
                hint={showValidation && validation.region ? validation.region : undefined}
              >
                <Input
                  id="s3-region"
                  value={draft.region}
                  maxLength={100}
                  placeholder="us-east-1"
                  disabled={save.isPending}
                  aria-invalid={showValidation && Boolean(validation.region)}
                  onChange={(event) => {
                    beginEdit();
                    setDraft((current) => ({ ...current, region: event.target.value }));
                  }}
                />
              </Field>
            </div>

            <Field
              label="Endpoint (optional)"
              htmlFor="s3-endpoint"
              hint={
                showValidation && validation.endpoint
                  ? validation.endpoint
                  : 'Leave blank for AWS S3. Use an absolute HTTP(S) URL for MinIO or another compatible service.'
              }
            >
              <Input
                id="s3-endpoint"
                type="url"
                value={draft.endpoint}
                maxLength={2_048}
                placeholder="https://s3.example.com"
                disabled={save.isPending}
                aria-invalid={showValidation && Boolean(validation.endpoint)}
                onChange={(event) => {
                  beginEdit();
                  setDraft((current) => ({ ...current, endpoint: event.target.value }));
                }}
              />
            </Field>

            <Field
              label="Access key ID"
              htmlFor="s3-access-key-id"
              hint={
                showValidation && validation.accessKeyId
                  ? validation.accessKeyId
                  : 'Stored as connection metadata; this is not the secret access key.'
              }
            >
              <Input
                id="s3-access-key-id"
                value={draft.accessKeyId}
                maxLength={255}
                autoComplete="off"
                disabled={save.isPending}
                aria-invalid={showValidation && Boolean(validation.accessKeyId)}
                onChange={(event) => {
                  beginEdit();
                  setDraft((current) => ({ ...current, accessKeyId: event.target.value }));
                }}
              />
            </Field>

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
                label={
                  saved.s3.hasCredential ? 'Replacement secret access key' : 'Secret access key'
                }
                htmlFor="s3-secret-access-key"
                hint={
                  showValidation && validation.secretAccessKey
                    ? validation.secretAccessKey
                    : 'Leave blank to keep the stored value. Use Clear for explicit removal.'
                }
              >
                <Input
                  id="s3-secret-access-key"
                  type="password"
                  value={secretAccessKey}
                  maxLength={2_049}
                  autoComplete="new-password"
                  disabled={save.isPending}
                  aria-invalid={showValidation && Boolean(validation.secretAccessKey)}
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

            <div className="flex items-start justify-between gap-6 rounded-lg border border-[var(--border-subtle)] p-4">
              <div>
                <label htmlFor="s3-force-path-style" className="text-sm font-medium">
                  Force path-style addressing
                </label>
                <p
                  id="s3-force-path-style-description"
                  className="mt-1 text-xs text-[var(--text-muted)]"
                >
                  Usually required by MinIO and self-hosted S3-compatible gateways.
                </p>
              </div>
              <Switch
                id="s3-force-path-style"
                checked={draft.forcePathStyle}
                disabled={save.isPending}
                aria-describedby="s3-force-path-style-description"
                onCheckedChange={(forcePathStyle) => {
                  beginEdit();
                  setDraft((current) => ({ ...current, forcePathStyle }));
                }}
              />
            </div>

            <div className="rounded-lg border border-[var(--border-subtle)] p-4">
              <p className="text-sm font-medium">Test saved S3 settings</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                The read-only check requires bucket-level access. The write test creates a random
                object under <code>.oci-health-check/</code>, verifies it, and deletes it.
              </p>
              {hasChanges && (
                <p className="mt-2 text-xs text-[var(--warning)]">
                  Save changes before testing them.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={hasChanges || health.isPending || save.isPending}
                  onClick={() => health.mutate('read')}
                >
                  {health.isPending && health.variables === 'read' && <Spinner />}
                  Check bucket access
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={hasChanges || health.isPending || save.isPending}
                  onClick={() => health.mutate('write')}
                >
                  {health.isPending && health.variables === 'write' && <Spinner />}
                  Test put/read/delete
                </Button>
              </div>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Upload policy"
          description="Limits are enforced by the attachment API for every uploaded file and message."
        >
          <div className="flex flex-col gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Maximum file size (bytes)"
                htmlFor="max-file-bytes"
                hint={
                  showValidation && validation.maxFileBytes
                    ? validation.maxFileBytes
                    : Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0
                      ? `Currently ${formatBytes(maxFileBytes)} per file.`
                      : 'Enter a positive whole number.'
                }
              >
                <Input
                  id="max-file-bytes"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={draft.maxFileBytes}
                  disabled={save.isPending}
                  aria-invalid={showValidation && Boolean(validation.maxFileBytes)}
                  onChange={(event) => {
                    beginEdit();
                    setDraft((current) => ({ ...current, maxFileBytes: event.target.value }));
                  }}
                />
              </Field>

              <Field
                label="Maximum files per message"
                htmlFor="max-files-per-message"
                hint={
                  showValidation && validation.maxFilesPerMessage
                    ? validation.maxFilesPerMessage
                    : 'Maximum attachment count accepted on one message.'
                }
              >
                <Input
                  id="max-files-per-message"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={draft.maxFilesPerMessage}
                  disabled={save.isPending}
                  aria-invalid={showValidation && Boolean(validation.maxFilesPerMessage)}
                  onChange={(event) => {
                    beginEdit();
                    setDraft((current) => ({
                      ...current,
                      maxFilesPerMessage: event.target.value,
                    }));
                  }}
                />
              </Field>
            </div>

            <Field
              label="Allowed MIME types"
              htmlFor="allowed-mime-types"
              hint={
                showValidation && validation.allowedMimeTypes
                  ? validation.allowedMimeTypes
                  : 'One MIME type per line (commas are accepted). An empty list blocks every file type.'
              }
            >
              <Textarea
                id="allowed-mime-types"
                rows={8}
                value={draft.allowedMimeTypes}
                disabled={save.isPending}
                spellCheck={false}
                aria-invalid={showValidation && Boolean(validation.allowedMimeTypes)}
                placeholder={'image/png\napplication/pdf\ntext/plain'}
                onChange={(event) => {
                  beginEdit();
                  setDraft((current) => ({ ...current, allowedMimeTypes: event.target.value }));
                }}
              />
            </Field>
          </div>
        </SettingsSection>

        <div className="flex min-h-9 flex-col gap-3 border-t border-[var(--border-subtle)] pt-6 sm:flex-row sm:items-center sm:justify-end">
          <div className="sm:mr-auto" aria-live="polite">
            {errorMessage && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {errorMessage}
              </p>
            )}
            {successMessage && (
              <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                <CheckCircle2 className="size-4" /> Storage settings saved.
              </p>
            )}
            {healthMessage && (
              <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                <CheckCircle2 className="size-4" /> {healthMessage}
              </p>
            )}
          </div>
          <Button type="submit" variant="primary" disabled={!hasChanges || save.isPending}>
            {save.isPending && <Spinner />}
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>

      <Dialog open={showDriverConfirmation} onOpenChange={setShowDriverConfirmation}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change the active storage driver?</DialogTitle>
            <DialogDescription>
              This changes where all attachment reads and new writes are directed. It does not copy
              existing files.
            </DialogDescription>
          </DialogHeader>
          <DriverWarning driver={draft.driver} />
          {draft.driver === 's3' && (
            <p className="text-sm text-[var(--text-muted)]">
              The server will reject this change unless the bucket, region, access key ID, and
              encrypted secret are all configured. Test the saved connection before switching.
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => setShowDriverConfirmation(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={save.isPending}
              onClick={() => save.mutate(patch)}
            >
              {save.isPending && <Spinner />}
              Change driver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AdminStoragePage() {
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<InstanceSettings>('/admin/settings'),
  });

  return (
    <div>
      <AdminPageHeader
        title="Storage"
        description="Manage the attachment backend and upload policy for this instance."
      />

      {settings.isLoading ? (
        <LoadingStorageSettings />
      ) : settings.isError || !settings.data ? (
        <div className="max-w-3xl">
          <p role="alert" className="text-sm text-[var(--danger)]">
            {settings.error instanceof ApiError
              ? settings.error.message
              : 'Unable to load storage settings.'}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4"
            disabled={settings.isFetching}
            onClick={() => settings.refetch()}
          >
            {settings.isFetching && <Spinner />} Try again
          </Button>
        </div>
      ) : (
        <StorageSettingsForm initialSettings={settings.data.storage} />
      )}
    </div>
  );
}
