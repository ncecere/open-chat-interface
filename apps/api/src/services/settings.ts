import { and, eq, schema } from '@oci/db';
import {
  COLOR_THEMES,
  type ColorTheme,
  type ReasoningEffort,
  type RoleFeatures,
  type SearchProviderKind,
  type UserRole,
} from '@oci/shared';
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
  | 'rateLimits'
  | 'roleFeatures'
  | 'roleTools'
  | 'embeddings'
  | 'reranking'
  | 'backups'
  | 'compliance';

export interface BrandingSettings {
  appName: string;
  /** Optional compact mark for the sidebar; initials are derived when unset. */
  shortName: string | null;
  /**
   * Either an external URL or a storage key under `branding/`. An uploaded
   * logo is stored rather than linked so it survives the source going away.
   */
  logoUrl: string | null;
  /** Content type of an uploaded logo; unused for an external URL. */
  logoMimeType: string | null;
  accentColor: string | null;
  loginMessage: string | null;
  defaultTheme: 'light' | 'dark' | 'system';
  colorTheme: ColorTheme;
}

/** Supplies a color theme for settings written before themes were selectable. */
export function normalizeBrandingSettings(value: BrandingSettings): BrandingSettings {
  return {
    ...value,
    // Written before a short name was configurable.
    shortName: value?.shortName ?? null,
    logoMimeType: value?.logoMimeType ?? null,
    colorTheme: COLOR_THEMES.includes(value?.colorTheme as ColorTheme)
      ? value.colorTheme
      : 'neutral',
  };
}

export interface AuthSettings {
  registrationMode: 'open' | 'invite_only' | 'closed';
  emailVerificationRequired: boolean;
  localAuthEnabled: boolean;
  /**
   * How long a session stays valid, and how often activity extends it.
   *
   * Read at request time rather than at startup so a change takes effect
   * without a restart. Shortening it does not retroactively expire sessions
   * already issued; those last until their own expiry.
   */
  sessionLifetimeDays: number;
  sessionRefreshDays: number;
}

export interface FeatureSettings {
  shareLinks: boolean;
  temporaryChat: boolean;
  webSearch: boolean;
  attachments: boolean;
  branching: boolean;
  /** User memory (v0.9). Absent before v0.9; read as off. */
  memory: boolean;
}

/**
 * Supplies session lifetimes to auth settings written before they existed.
 *
 * An upgraded instance has a stored `auth` object without these keys, and an
 * undefined lifetime would otherwise reach Better Auth as `NaN` seconds.
 */
export function normalizeAuthSettings(value: AuthSettings): AuthSettings {
  return {
    ...value,
    sessionLifetimeDays: value.sessionLifetimeDays ?? 30,
    sessionRefreshDays: value.sessionRefreshDays ?? 1,
  };
}

/** Drops retired flags and reads a missing memory switch (before v0.9) as off. */
export function normalizeFeatureSettings(value: FeatureSettings): FeatureSettings {
  // Retired switches that never controlled anything. Dropping them on read
  // also removes them from storage the next time features are saved.
  const {
    personas: _personas,
    canvas: _canvas,
    mcp: _mcp,
    ...normalized
  } = value as FeatureSettings & { personas?: boolean; canvas?: boolean; mcp?: boolean };
  // Memory is off unless an administrator switched it on.
  return { ...normalized, memory: normalized.memory === true };
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
  provider: SearchProviderKind | null;
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
  /** Absent on settings written before it was configurable; read as `instant`. */
  defaultEffort?: ReasoningEffort;
  /** Model steps per reply when tools are used. Absent before v0.8; read as the default (8). */
  maxToolSteps?: number;
  /** Summarise earlier turns when a conversation outgrows the model. Absent before v0.9; read as on. */
  autoCompact?: boolean;
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
  /** User memory (v0.9): delete memories not updated for this many days; null keeps them. */
  memoryRetentionDays?: number | null;
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

/**
 * Per-role feature overrides. Sparse like the rate limits: a role or field
 * that was never saved falls back to `DEFAULT_ROLE_FEATURES`.
 */
/**
 * Per-role tool allow, sparse: a tool never saved for a role falls back to
 * `defaultToolAllowed`, so tools registered later inherit a default.
 */
export interface StoredRoleToolSettings {
  roles?: Partial<Record<UserRole, Record<string, boolean>>>;
}

export interface StoredRoleFeatureSettings {
  roles?: Partial<Record<UserRole, Partial<RoleFeatures>>>;
}

/**
 * Meaning-based search for project files (v0.9). Sparse: never saved means
 * off. Normalised by `embeddingsSettings` in services/embeddings/config.ts.
 */
export interface StoredEmbeddingsSettings {
  enabled?: boolean;
  providerId?: string | null;
  modelId?: string | null;
  dimensions?: number | null;
  inputPriceMicros?: number | null;
}

/**
 * Reranking of project search results (v0.9). Sparse: never saved means off.
 * Normalised by `rerankingSettings` in services/reranking/config.ts.
 */
export interface StoredRerankingSettings {
  enabled?: boolean;
  providerId?: string | null;
  modelId?: string | null;
  searchPriceMicros?: number | null;
}

/**
 * Automated backups (v0.9). Sparse: never saved means off. Normalised by
 * `backupSettings` in services/backups/settings.ts.
 */
export interface StoredBackupSettings {
  enabled?: boolean;
  hourUtc?: number;
  destination?: 'storage' | 'separate';
  prefix?: string;
  s3?: Partial<S3StorageSettings>;
  keepDaily?: number;
  keepWeekly?: number;
}

/**
 * Compliance export (v0.9). Sparse: never saved means off. Normalised by
 * `complianceSettings` in services/compliance/settings.ts.
 */
export interface StoredComplianceSettings {
  enabled?: boolean;
  schedule?: 'hourly' | 'daily';
  hourUtc?: number;
  destination?: 'storage' | 'separate';
  prefix?: string;
  s3?: Partial<S3StorageSettings>;
  includeContent?: boolean;
  keepDays?: number | null;
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
  roleFeatures: StoredRoleFeatureSettings;
  roleTools: StoredRoleToolSettings;
  embeddings: StoredEmbeddingsSettings;
  reranking: StoredRerankingSettings;
  backups: StoredBackupSettings;
  compliance: StoredComplianceSettings;
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
          : key === 'auth'
            ? normalizeAuthSettings(stored as AuthSettings)
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
