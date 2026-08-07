import type { InstanceSettings, UpdateInstanceSettings } from '@oci/shared';
import type { S3StorageSettings } from '../settings.js';

type PublicS3Settings = InstanceSettings['storage']['s3'];
type S3SettingsPatch = NonNullable<NonNullable<UpdateInstanceSettings['storage']>['s3']>;

export interface S3ConfigurationIssue {
  field: 'bucket' | 'region' | 'endpoint' | 'accessKeyId' | 'secretAccessKey';
  message: string;
}

/** Returns only connection metadata and credential presence, never encrypted secret material. */
export function toPublicS3Settings(settings: S3StorageSettings): PublicS3Settings {
  return {
    bucket: settings.bucket,
    region: settings.region,
    endpoint: settings.endpoint,
    accessKeyId: settings.accessKeyId,
    forcePathStyle: settings.forcePathStyle,
    hasCredential: Boolean(settings.encryptedSecretAccessKey),
  };
}

/** Applies write-only secret semantics: omitted/blank keeps, a value replaces, and null clears. */
export function applyS3SettingsPatch(
  current: S3StorageSettings,
  patch: S3SettingsPatch,
  encrypt: (secret: string) => string,
): S3StorageSettings {
  const { secretAccessKey, ...publicPatch } = patch;
  return {
    ...current,
    ...publicPatch,
    ...(secretAccessKey === null
      ? { encryptedSecretAccessKey: null }
      : secretAccessKey
        ? { encryptedSecretAccessKey: encrypt(secretAccessKey) }
        : {}),
  };
}

/** Validates everything the S3 driver needs without exposing the stored secret. */
export function getS3ConfigurationIssues(settings: S3StorageSettings): S3ConfigurationIssue[] {
  const issues: S3ConfigurationIssue[] = [];

  if (!settings.bucket.trim()) {
    issues.push({ field: 'bucket', message: 'S3 bucket is required.' });
  }
  if (!settings.region.trim()) {
    issues.push({ field: 'region', message: 'S3 region is required.' });
  }
  if (!settings.accessKeyId.trim()) {
    issues.push({ field: 'accessKeyId', message: 'S3 access key ID is required.' });
  }
  if (!settings.encryptedSecretAccessKey) {
    issues.push({ field: 'secretAccessKey', message: 'S3 secret access key is required.' });
  }

  if (settings.endpoint) {
    try {
      const endpoint = new URL(settings.endpoint);
      if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
        issues.push({ field: 'endpoint', message: 'S3 endpoint must use HTTP or HTTPS.' });
      }
      if (endpoint.username || endpoint.password) {
        issues.push({ field: 'endpoint', message: 'S3 endpoint must not include credentials.' });
      }
    } catch {
      issues.push({ field: 'endpoint', message: 'S3 endpoint must be a valid absolute URL.' });
    }
  }

  return issues;
}
