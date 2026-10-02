import {
  COMPLIANCE_STORAGE_PREFIX,
  type ComplianceSettings,
  type UpdateComplianceSettingsInput,
} from '@oci/shared';
import { encryptSecret } from '../../lib/crypto.js';
import { type BackupTarget, destinationIssues, resolveDestination } from '../backups/settings.js';
import {
  DEFAULT_S3_STORAGE_SETTINGS,
  getSetting,
  type S3StorageSettings,
  type StoredComplianceSettings,
  updateSetting,
} from '../settings.js';
import { applyS3SettingsPatch } from '../storage/config.js';

/**
 * Where compliance exports go, when they run, and what they include. The
 * destination works exactly as for backups (services/backups/settings.ts):
 * the attachment bucket under the reserved `.oci-compliance/` prefix, or a
 * separate bucket with its own encrypted credentials.
 */

export interface ResolvedComplianceSettings {
  enabled: boolean;
  schedule: 'hourly' | 'daily';
  hourUtc: number;
  destination: 'storage' | 'separate';
  prefix: string;
  s3: S3StorageSettings;
  includeContent: boolean;
  keepDays: number | null;
}

export const DEFAULT_COMPLIANCE_PREFIX = 'oci-compliance/';
const PURPOSE = 'compliance exports';

export function normalizeComplianceSettings(
  stored: StoredComplianceSettings,
): ResolvedComplianceSettings {
  return {
    enabled: stored.enabled ?? false,
    schedule: stored.schedule ?? 'daily',
    hourUtc: stored.hourUtc ?? 2,
    destination: stored.destination ?? 'storage',
    prefix: stored.prefix ?? DEFAULT_COMPLIANCE_PREFIX,
    s3: { ...DEFAULT_S3_STORAGE_SETTINGS, ...(stored.s3 ?? {}) },
    // Content is the sensitive part: never on unless an administrator says so.
    includeContent: stored.includeContent ?? false,
    // Institutions usually keep these records; deleting them is opt-in.
    keepDays: stored.keepDays ?? null,
  };
}

export async function complianceSettings(): Promise<ResolvedComplianceSettings> {
  return normalizeComplianceSettings(await getSetting('compliance'));
}

/** Settings as administrators see them; the secret only as set or not set. */
export function toPublicComplianceSettings(
  settings: ResolvedComplianceSettings,
): ComplianceSettings {
  return {
    enabled: settings.enabled,
    schedule: settings.schedule,
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
    includeContent: settings.includeContent,
    keepDays: settings.keepDays,
  };
}

/** Merges a validated patch; secrets are write-only (blank keeps, value replaces, null clears). */
export function applyComplianceSettingsPatch(
  current: ResolvedComplianceSettings,
  patch: UpdateComplianceSettingsInput,
): ResolvedComplianceSettings {
  const { s3, ...rest } = patch;
  return {
    ...current,
    ...rest,
    s3: s3 ? applyS3SettingsPatch(current.s3, s3, encryptSecret) : current.s3,
  };
}

/** The fields that changed, for the audit entry; never a credential value. */
export function changedComplianceFields(
  before: ResolvedComplianceSettings,
  after: ResolvedComplianceSettings,
): string[] {
  const fields: string[] = [];
  for (const key of [
    'enabled',
    'schedule',
    'hourUtc',
    'destination',
    'prefix',
    'includeContent',
    'keepDays',
  ] as const)
    if (before[key] !== after[key]) fields.push(key);
  for (const key of ['bucket', 'region', 'endpoint', 'accessKeyId', 'forcePathStyle'] as const)
    if (before.s3[key] !== after.s3[key]) fields.push(`s3.${key}`);
  if (before.s3.encryptedSecretAccessKey !== after.s3.encryptedSecretAccessKey)
    fields.push('s3.secretAccessKey');
  return fields;
}

export async function saveComplianceSettings(settings: ResolvedComplianceSettings): Promise<void> {
  await updateSetting('compliance', settings);
}

/** Why an export cannot be written with these settings; empty when it can. Does not contact S3. */
export function complianceConfigurationIssues(
  settings: ResolvedComplianceSettings,
): Promise<string[]> {
  return destinationIssues(settings, PURPOSE);
}

/** Resolves the destination; throws with the configuration issues when there are any. */
export function resolveComplianceTarget(
  settings: ResolvedComplianceSettings,
): Promise<BackupTarget> {
  return resolveDestination(settings, COMPLIANCE_STORAGE_PREFIX, PURPOSE);
}

/** The key prefix runs at this destination are written under. */
export function complianceKeyPrefix(settings: ResolvedComplianceSettings): string {
  return settings.destination === 'storage' ? COMPLIANCE_STORAGE_PREFIX : settings.prefix;
}
