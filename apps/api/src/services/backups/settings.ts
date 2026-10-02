import {
  BACKUP_STORAGE_PREFIX,
  type BackupSettings,
  DEFAULT_BACKUP_KEEP_DAILY,
  DEFAULT_BACKUP_KEEP_WEEKLY,
  type UpdateBackupSettingsInput,
} from '@oci/shared';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import {
  DEFAULT_S3_STORAGE_SETTINGS,
  getSetting,
  type S3StorageSettings,
  type StoredBackupSettings,
  updateSetting,
} from '../settings.js';
import { applyS3SettingsPatch, getS3ConfigurationIssues } from '../storage/config.js';
import { S3StorageDriver } from '../storage/s3-driver.js';

/**
 * Where backups go, and how many are kept.
 *
 * Two destinations:
 * - `storage`: the attachment S3 bucket, under the reserved `.oci-backups/`
 *   prefix (storage reconciliation skips it). Nothing more to configure, but
 *   one credential and one bucket now hold both the data and its backups.
 * - `separate`: its own bucket and encrypted credentials. Recommended: losing
 *   or leaking the attachment bucket's credentials then does not also lose
 *   the backups, and the target can carry its own versioning or object lock.
 */

export interface ResolvedBackupSettings {
  enabled: boolean;
  hourUtc: number;
  destination: 'storage' | 'separate';
  prefix: string;
  s3: S3StorageSettings;
  keepDaily: number;
  keepWeekly: number;
}

export const DEFAULT_BACKUP_PREFIX = 'oci-backups/';

export function normalizeBackupSettings(stored: StoredBackupSettings): ResolvedBackupSettings {
  return {
    enabled: stored.enabled ?? false,
    hourUtc: stored.hourUtc ?? 3,
    destination: stored.destination ?? 'storage',
    prefix: stored.prefix ?? DEFAULT_BACKUP_PREFIX,
    s3: { ...DEFAULT_S3_STORAGE_SETTINGS, ...(stored.s3 ?? {}) },
    keepDaily: stored.keepDaily ?? DEFAULT_BACKUP_KEEP_DAILY,
    keepWeekly: stored.keepWeekly ?? DEFAULT_BACKUP_KEEP_WEEKLY,
  };
}

export async function backupSettings(): Promise<ResolvedBackupSettings> {
  return normalizeBackupSettings(await getSetting('backups'));
}

/** Settings as administrators see them; the secret only as set or not set. */
export function toPublicBackupSettings(settings: ResolvedBackupSettings): BackupSettings {
  return {
    enabled: settings.enabled,
    hourUtc: settings.hourUtc,
    destination: settings.destination,
    prefix: settings.prefix,
    s3: {
      bucket: settings.s3.bucket,
      region: settings.s3.region,
      endpoint: settings.s3.endpoint,
      accessKeyId: settings.s3.accessKeyId,
      forcePathStyle: settings.s3.forcePathStyle,
      hasCredential: Boolean(settings.s3.encryptedSecretAccessKey),
    },
    keepDaily: settings.keepDaily,
    keepWeekly: settings.keepWeekly,
  };
}

/** Merges a validated patch; secrets are write-only (blank keeps, value replaces, null clears). */
export function applyBackupSettingsPatch(
  current: ResolvedBackupSettings,
  patch: UpdateBackupSettingsInput,
): ResolvedBackupSettings {
  const { s3, ...rest } = patch;
  return {
    ...current,
    ...rest,
    s3: s3 ? applyS3SettingsPatch(current.s3, s3, encryptSecret) : current.s3,
  };
}

/** The fields that changed, for the audit entry; never a credential value. */
export function changedBackupFields(
  before: ResolvedBackupSettings,
  after: ResolvedBackupSettings,
): string[] {
  const fields: string[] = [];
  for (const key of [
    'enabled',
    'hourUtc',
    'destination',
    'prefix',
    'keepDaily',
    'keepWeekly',
  ] as const)
    if (before[key] !== after[key]) fields.push(key);
  for (const key of ['bucket', 'region', 'endpoint', 'accessKeyId', 'forcePathStyle'] as const)
    if (before.s3[key] !== after.s3[key]) fields.push(`s3.${key}`);
  if (before.s3.encryptedSecretAccessKey !== after.s3.encryptedSecretAccessKey)
    fields.push('s3.secretAccessKey');
  return fields;
}

export async function saveBackupSettings(settings: ResolvedBackupSettings): Promise<void> {
  await updateSetting('backups', settings);
}

/** A resolved place to write: the S3 driver and the key prefix every object goes under. */
export interface BackupTarget {
  driver: S3StorageDriver;
  root: string;
  bucket: string;
}

const sameEndpoint = (a: string | null, b: string | null) =>
  (a ?? '').replace(/\/+$/, '').toLowerCase() === (b ?? '').replace(/\/+$/, '').toLowerCase();

/** A destination as backups and compliance exports both configure it. */
export interface S3DestinationSettings {
  destination: 'storage' | 'separate';
  prefix: string;
  s3: S3StorageSettings;
}

/**
 * Why objects cannot be written to this destination; empty when they can.
 * `purpose` names what is written (`backups`, `compliance exports`) in the
 * messages. Does not contact S3 (see "Test destination").
 */
export async function destinationIssues(
  settings: S3DestinationSettings,
  purpose: string,
): Promise<string[]> {
  const storage = await getSetting('storage');
  if (settings.destination === 'storage') {
    if (storage.driver !== 's3')
      return [
        `Attachments are stored on the local disk. Choose a separate S3 bucket for ${purpose}, or move attachments to S3.`,
      ];
    return getS3ConfigurationIssues(storage.s3).map(
      (issue) => `Attachment storage: ${issue.message}`,
    );
  }
  const issues = getS3ConfigurationIssues(settings.s3).map((issue) => issue.message);
  if (
    storage.driver === 's3' &&
    settings.s3.bucket.trim() &&
    settings.s3.bucket.trim() === storage.s3.bucket.trim() &&
    sameEndpoint(settings.s3.endpoint, storage.s3.endpoint)
  )
    issues.push(
      `This is the attachment bucket. Choose “Attachment storage” as the destination to use it, so storage reconciliation leaves the ${purpose} alone.`,
    );
  return issues;
}

/**
 * Why a backup cannot be written with these settings; empty when it can.
 * Does not contact S3 (see "Test destination").
 */
export async function backupConfigurationIssues(
  settings: ResolvedBackupSettings,
): Promise<string[]> {
  return destinationIssues(settings, 'backups');
}

function driverFor(s3: S3StorageSettings): S3StorageDriver {
  let secretAccessKey: string;
  try {
    secretAccessKey = decryptSecret(s3.encryptedSecretAccessKey as string);
  } catch {
    throw new Error('The S3 secret access key could not be decrypted');
  }
  return new S3StorageDriver({
    bucket: s3.bucket,
    region: s3.region,
    endpoint: s3.endpoint,
    accessKeyId: s3.accessKeyId,
    secretAccessKey,
    forcePathStyle: s3.forcePathStyle,
  });
}

/**
 * Resolves a destination: the attachment bucket under `reservedPrefix`, or the
 * separate bucket under its own prefix. Throws with the issues when there are any.
 */
export async function resolveDestination(
  settings: S3DestinationSettings,
  reservedPrefix: string,
  purpose: string,
): Promise<BackupTarget> {
  const issues = await destinationIssues(settings, purpose);
  if (issues.length > 0) throw new Error(issues.join(' '));
  if (settings.destination === 'storage') {
    const storage = await getSetting('storage');
    return { driver: driverFor(storage.s3), root: reservedPrefix, bucket: storage.s3.bucket };
  }
  return { driver: driverFor(settings.s3), root: settings.prefix, bucket: settings.s3.bucket };
}

/** Resolves the destination; throws with the configuration issues when there are any. */
export async function resolveBackupTarget(settings: ResolvedBackupSettings): Promise<BackupTarget> {
  return resolveDestination(settings, BACKUP_STORAGE_PREFIX, 'backups');
}
