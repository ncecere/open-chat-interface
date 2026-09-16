import { KeyRound } from 'lucide-react';
import { SettingsSection } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { S3CredentialEditor } from './s3-credential-editor';
import type { StorageSettingsController } from './use-storage-settings';

export function S3Panel({ controller }: { controller: StorageSettingsController }) {
  const { draft, setDraft, showValidation, validation, save, beginEdit, health, hasChanges } =
    controller;

  return (
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

        <S3CredentialEditor controller={controller} />

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
            The read-only check requires bucket-level access. The write test creates a random object
            under <code>.oci-health-check/</code>, verifies it, and deletes it.
          </p>
          {hasChanges && (
            <p className="mt-2 text-xs text-[var(--warning)]">Save changes before testing them.</p>
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
  );
}
