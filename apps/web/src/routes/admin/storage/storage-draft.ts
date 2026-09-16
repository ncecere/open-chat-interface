import type { InstanceSettings, StorageDriver, UpdateInstanceSettings } from '@oci/shared';

export type StorageSettings = InstanceSettings['storage'];
export type StoragePatch = NonNullable<UpdateInstanceSettings['storage']>;
type S3Patch = NonNullable<StoragePatch['s3']>;
export type CredentialAction = 'keep' | 'replace' | 'clear';
export type HealthMode = 'read' | 'write';

export interface StorageDraft {
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

export interface StorageValidation {
  maxFileBytes?: string;
  maxFilesPerMessage?: string;
  allowedMimeTypes?: string;
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export function makeDraft(settings: StorageSettings): StorageDraft {
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

export function parseMimeTypes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((mimeType) => mimeType.trim())
        .filter(Boolean),
    ),
  ];
}

export function validateDraft(
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

export function changedStorageSettings(
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
