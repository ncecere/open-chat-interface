import { and, eq, schema } from '@oci/db';
import { COLOR_THEMES, type ColorTheme, type UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { getDefaultOrganizationId } from './organization.js';

export type SettingKey =
  | 'branding'
  | 'auth'
  | 'features'
  | 'storage'
  | 'search'
  | 'smtp'
  | 'chat'
  | 'retention'
  | 'rateLimits';

export interface BrandingSettings {
  appName: string;
  logoUrl: string | null;
  accentColor: string | null;
  loginMessage: string | null;
  defaultTheme: 'light' | 'dark' | 'system';
  colorTheme: ColorTheme;
}

/** Supplies a color theme for settings written before themes were selectable. */
export function normalizeBrandingSettings(value: BrandingSettings): BrandingSettings {
  return {
    ...value,
    colorTheme: COLOR_THEMES.includes(value?.colorTheme as ColorTheme)
      ? value.colorTheme
      : 'neutral',
  };
}

export interface AuthSettings {
  registrationMode: 'open' | 'invite_only' | 'closed';
  emailVerificationRequired: boolean;
  localAuthEnabled: boolean;
}

export interface FeatureSettings {
  shareLinks: boolean;
  temporaryChat: boolean;
  canvas: boolean;
  mcp: boolean;
  webSearch: boolean;
  attachments: boolean;
  branching: boolean;
}

/** Drops the retired persona flag from settings written by older releases. */
export function normalizeFeatureSettings(value: FeatureSettings): FeatureSettings {
  const normalized = { ...value } as FeatureSettings & { personas?: boolean };
  delete normalized.personas;
  return normalized;
}

export interface S3StorageSettings {
  bucket: string;
  region: string;
  endpoint: string | null;
  accessKeyId: string;
  encryptedSecretAccessKey: string | null;
  forcePathStyle: boolean;
}

export interface StorageSettings {
  driver: 'local' | 's3';
  maxFileBytes: number;
  maxFilesPerMessage: number;
  allowedMimeTypes: string[];
  s3: S3StorageSettings;
}

export const DEFAULT_S3_STORAGE_SETTINGS: S3StorageSettings = {
  bucket: '',
  region: 'us-east-1',
  endpoint: null,
  accessKeyId: '',
  encryptedSecretAccessKey: null,
  forcePathStyle: false,
};

/** Adds S3 defaults to settings written before object storage was publicly configurable. */
export function normalizeStorageSettings(value: StorageSettings): StorageSettings {
  const legacy = value as StorageSettings & {
    s3?: Partial<S3StorageSettings> & { encryptedSecretKey?: string | null };
  };
  const s3 = legacy.s3;
  const { encryptedSecretKey, ...currentS3 } = s3 ?? {};

  return {
    ...value,
    s3: {
      ...DEFAULT_S3_STORAGE_SETTINGS,
      ...currentS3,
      encryptedSecretAccessKey: s3?.encryptedSecretAccessKey ?? encryptedSecretKey ?? null,
    },
  };
}

export interface SearchSettings {
  enabled: boolean;
  provider: 'searxng' | 'tavily' | 'brave' | 'exa' | null;
  baseUrl: string | null;
  encryptedApiKey: string | null;
  maxResults: number;
}

export interface SmtpSettings {
  host: string | null;
  port: number | null;
  secure: boolean;
  fromAddress: string | null;
  username: string | null;
  encryptedPassword: string | null;
}

export interface ChatSettings {
  defaultSystemPrompt: string | null;
}

/**
 * Stored retention overrides. Every field is optional: an absent value falls
 * back to the environment default rather than being written on first read.
 */
export interface StoredRetentionSettings {
  trashRetentionDays?: number;
  threadRetentionDays?: number | null;
  exemptPinnedThreads?: boolean;
  usageEventRetentionDays?: number;
  auditLogRetentionDays?: number;
  /** Presentation only; policy timezones govern when limits actually reset. */
  displayTimezone?: string;
}

export interface StoredRateLimitSettings {
  roles?: Partial<
    Record<
      UserRole,
      {
        maxConcurrentStreams?: number;
        chatRequestsPerMinute?: number;
        uploadRequestsPerMinute?: number;
      }
    >
  >;
  authAttemptsPerMinute?: number;
  reserve?: { costMicros?: number; tokens?: number };
}

interface SettingsMap {
  branding: BrandingSettings;
  auth: AuthSettings;
  features: FeatureSettings;
  storage: StorageSettings;
  search: SearchSettings;
  smtp: SmtpSettings;
  chat: ChatSettings;
  retention: StoredRetentionSettings;
  rateLimits: StoredRateLimitSettings;
}

/**
 * Settings change rarely and are read on nearly every request, so they are
 * cached. The TTL exists for multi-replica deployments: `invalidateSettingsCache`
 * only clears the calling process, so without expiry an administrator's change
 * would never reach the other replicas.
 */
const CACHE_TTL_MS = 30_000;

const cache = new Map<SettingKey, { value: unknown; expiresAt: number }>();

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value as SettingsMap[K];

  const organizationId = await getDefaultOrganizationId();
  const [row] = await db
    .select({ value: schema.instanceSetting.value })
    .from(schema.instanceSetting)
    .where(
      and(
        eq(schema.instanceSetting.organizationId, organizationId),
        eq(schema.instanceSetting.key, key),
      ),
    )
    .limit(1);

  const stored = (row?.value ?? {}) as unknown as SettingsMap[K];
  const value = (
    key === 'storage'
      ? normalizeStorageSettings(stored as StorageSettings)
      : key === 'branding'
        ? normalizeBrandingSettings(stored as BrandingSettings)
        : key === 'features'
          ? normalizeFeatureSettings(stored as FeatureSettings)
          : stored
  ) as SettingsMap[K];
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function updateSetting<K extends SettingKey>(
  key: K,
  patch: Partial<SettingsMap[K]>,
): Promise<SettingsMap[K]> {
  const organizationId = await getDefaultOrganizationId();
  const current = await getSetting(key);
  const next = { ...current, ...patch } as SettingsMap[K];

  const serialized = next as unknown as Record<string, unknown>;

  await db
    .insert(schema.instanceSetting)
    .values({ organizationId, key, value: serialized })
    .onConflictDoUpdate({
      target: [schema.instanceSetting.organizationId, schema.instanceSetting.key],
      set: { value: serialized },
    });

  cache.set(key, { value: next, expiresAt: Date.now() + CACHE_TTL_MS });
  return next;
}

export function invalidateSettingsCache(key?: SettingKey): void {
  if (key) cache.delete(key);
  else cache.clear();
}
