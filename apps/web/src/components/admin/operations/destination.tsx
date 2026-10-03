import type { BackupDestination } from '@oci/shared';
import { useMutation } from '@tanstack/react-query';
import { EditOnly } from '~/components/admin/admin-access';
import { MutationError } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api } from '~/lib/api-client';

/**
 * Where an operations job (Backups, Compliance export) writes: the attachment
 * bucket under a fixed folder, or a separate S3-compatible bucket with its
 * own credentials. Shared by both pages since v0.10 so they cannot drift.
 */

/** A destination's saved settings, as both pages receive them. */
export interface DestinationSettings {
  destination: BackupDestination;
  prefix: string;
  s3: {
    bucket: string;
    region: string;
    endpoint: string | null;
    accessKeyId: string;
    forcePathStyle: boolean;
    /** Whether a secret access key is stored; the key itself is never sent. */
    hasCredential: boolean;
  };
}

/** The destination fields as typed. The secret is empty unless a new one was typed. */
export interface DestinationDraft {
  destination: BackupDestination;
  prefix: string;
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  secretAccessKey: string;
}

export const DESTINATION_OPTIONS: Array<{ value: BackupDestination; label: string }> = [
  { value: 'storage', label: 'Attachment storage bucket' },
  { value: 'separate', label: 'Separate S3 bucket (recommended)' },
];

export function destinationDraftFrom(settings: DestinationSettings): DestinationDraft {
  return {
    destination: settings.destination,
    prefix: settings.prefix,
    bucket: settings.s3.bucket,
    region: settings.s3.region,
    endpoint: settings.s3.endpoint ?? '',
    accessKeyId: settings.s3.accessKeyId,
    forcePathStyle: settings.s3.forcePathStyle,
    secretAccessKey: '',
  };
}

/**
 * Only what changed, as the settings PATCH takes it: `destination`, `prefix`
 * and an `s3` object with the changed fields. The secret is sent only when a
 * new one was typed; an empty field keeps the stored one.
 */
export function destinationChanges(
  settings: DestinationSettings,
  draft: DestinationDraft,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.destination !== settings.destination) patch.destination = draft.destination;
  if (draft.prefix.trim() !== settings.prefix) patch.prefix = draft.prefix.trim();
  const s3: Record<string, unknown> = {};
  if (draft.bucket.trim() !== settings.s3.bucket) s3.bucket = draft.bucket.trim();
  if (draft.region.trim() !== settings.s3.region) s3.region = draft.region.trim();
  if ((draft.endpoint.trim() || null) !== settings.s3.endpoint)
    s3.endpoint = draft.endpoint.trim() || null;
  if (draft.accessKeyId.trim() !== settings.s3.accessKeyId)
    s3.accessKeyId = draft.accessKeyId.trim();
  if (draft.forcePathStyle !== settings.s3.forcePathStyle) s3.forcePathStyle = draft.forcePathStyle;
  if (draft.secretAccessKey) s3.secretAccessKey = draft.secretAccessKey;
  if (Object.keys(s3).length > 0) patch.s3 = s3;
  return patch;
}

/** The destination menu; `hint` explains the choice currently selected. */
export function DestinationSelect({
  idPrefix,
  value,
  hint,
  onChange,
}: {
  idPrefix: string;
  value: BackupDestination;
  hint: string;
  onChange: (value: BackupDestination) => void;
}) {
  return (
    <Field label="Destination" htmlFor={`${idPrefix}-destination`} hint={hint}>
      <Select
        id={`${idPrefix}-destination`}
        value={value}
        onChange={(next) => onChange(next as BackupDestination)}
        options={DESTINATION_OPTIONS}
      />
    </Field>
  );
}

/**
 * The separate bucket's fields: bucket, region, endpoint, key prefix, access
 * key ID, a write-only secret (reported only as set or not set) and
 * path-style addressing. Field ids are `${idPrefix}-bucket` and so on.
 */
export function S3BucketFields({
  idPrefix,
  draft,
  onChange,
  hasCredential,
  prefixHint,
}: {
  idPrefix: string;
  draft: DestinationDraft;
  onChange: (change: Partial<DestinationDraft>) => void;
  hasCredential: boolean;
  prefixHint: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Bucket" htmlFor={`${idPrefix}-bucket`}>
        <Input
          id={`${idPrefix}-bucket`}
          value={draft.bucket}
          onChange={(e) => onChange({ bucket: e.target.value })}
        />
      </Field>
      <Field label="Region" htmlFor={`${idPrefix}-region`}>
        <Input
          id={`${idPrefix}-region`}
          value={draft.region}
          onChange={(e) => onChange({ region: e.target.value })}
        />
      </Field>
      <Field
        label="Endpoint (optional)"
        htmlFor={`${idPrefix}-endpoint`}
        hint="For MinIO and other S3-compatible services."
      >
        <Input
          id={`${idPrefix}-endpoint`}
          value={draft.endpoint}
          placeholder="https://s3.example.com"
          onChange={(e) => onChange({ endpoint: e.target.value })}
        />
      </Field>
      <Field label="Key prefix" htmlFor={`${idPrefix}-prefix`} hint={prefixHint}>
        <Input
          id={`${idPrefix}-prefix`}
          value={draft.prefix}
          onChange={(e) => onChange({ prefix: e.target.value })}
        />
      </Field>
      <Field label="Access key ID" htmlFor={`${idPrefix}-access-key`}>
        <Input
          id={`${idPrefix}-access-key`}
          value={draft.accessKeyId}
          autoComplete="off"
          onChange={(e) => onChange({ accessKeyId: e.target.value })}
        />
      </Field>
      <Field
        label="Secret access key"
        htmlFor={`${idPrefix}-secret`}
        hint={
          hasCredential
            ? 'Set. Leave empty to keep it; stored encrypted and never shown again.'
            : 'Not set. Stored encrypted and never shown again.'
        }
      >
        <Input
          id={`${idPrefix}-secret`}
          type="password"
          autoComplete="off"
          value={draft.secretAccessKey}
          onChange={(e) => onChange({ secretAccessKey: e.target.value })}
        />
      </Field>
      <div className="flex items-center justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3 sm:col-span-2">
        <label htmlFor={`${idPrefix}-path-style`} className="text-sm font-medium">
          Path-style addressing (MinIO and most self-hosted services)
        </label>
        <Switch
          id={`${idPrefix}-path-style`}
          checked={draft.forcePathStyle}
          onCheckedChange={(value) => onChange({ forcePathStyle: value })}
        />
      </div>
    </div>
  );
}

/**
 * "Test destination": checks the saved destination through `endpoint` (a
 * POST answering `{ ok, detail }`). Unsaved changes must be saved first, so
 * the test always checks what the job will use.
 */
export function DestinationTest({
  endpoint,
  hasChanges,
}: {
  endpoint: string;
  hasChanges: boolean;
}) {
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; detail: string }>(endpoint),
  });
  return (
    <>
      <EditOnly>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={test.isPending || hasChanges}
            onClick={() => test.mutate()}
          >
            {test.isPending && <Spinner />}
            Test destination
          </Button>
          <p aria-live="polite" className="text-sm">
            {hasChanges ? (
              <span className="text-[var(--text-muted)]">Save first to test these settings.</span>
            ) : test.data ? (
              <span className={test.data.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
                {test.data.detail}
              </span>
            ) : null}
          </p>
        </div>
      </EditOnly>
      <MutationError error={test.error} message="The destination could not be tested." />
    </>
  );
}
