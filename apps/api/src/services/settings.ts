import { and, eq, schema } from '@oci/db';
import {
  type CapacityLimits,
  COLOR_THEMES,
  type ColorTheme,
  type QueuePriority,
  type ReasoningEffort,
  type RoleFeatures,
  type SearchProviderKind,
  type UserRole,
} from '@oci/shared';
import { db } from '../db/index.js';
import { onCacheInvalidation, publishInvalidation } from './cache-bus/index.js';
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
  | 'compliance'
  | 'providerCapacity'
  | 'maintenance';

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
  /**
   * The fallback provider (v0.10), tried when the first one times out or
   * fails with a server or network error. Absent from settings saved before
   * v0.10, which read as no fallback.
   */
  fallbackProvider?: SearchProviderKind | null;
  fallbackBaseUrl?: string | null;
  encryptedFallbackApiKey?: string | null;
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
  /** Diagram Design guidance in the artifacts prompt. Absent before v0.9; read as on. */
  diagramGuidance?: boolean;
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
  /**
   * Copy attachment files to the destination (v0.10). Absent on instances
   * that saved backup settings before v0.10, which keeps them off until an
   * administrator turns copying on; see `normalizeBackupSettings`.
   */
  copyFiles?: boolean;
  verifyFiles?: 'sample' | 'all';
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

/**
 * Provider capacity (v0.11): limits per provider and per model, keyed by their
 * ids, and the queue's settings. Sparse: nothing saved means no limits.
 * Normalised by services/limits/capacity/settings.ts.
 */
export interface StoredProviderCapacitySettings {
  providers?: Record<string, Partial<CapacityLimits>>;
  models?: Record<string, Partial<CapacityLimits>>;
  queue?: {
    maxWaitSeconds?: number;
    rolePriority?: Partial<Record<UserRole, QueuePriority>>;
  };
}

/**
 * Read-only maintenance mode (v0.11 design, section 9). Sparse: nothing saved
 * means off. Normalised by services/maintenance/read-only.ts; the environment
 * (OCI_READ_ONLY) overrides it.
 */
export interface StoredMaintenanceSettings {
  readOnly?: boolean;
  /** Shown to people while read-only. */
  reason?: string | null;
  /** When an administrator expects to turn it off (ISO); null when unknown. */
  until?: string | null;
  /** Who switched it on or off last, and when (ISO). */
  changedAt?: string | null;
  changedBy?: string | null;
  /** A scheduled window: read-only from `startsAt` until `endsAt` (ISO). */
  window?: {
    startsAt: string;
    endsAt: string;
    reason?: string | null;
    /** The announcement made for it, updated or removed with the window. */
    announcementId?: string | null;
  } | null;
  /** Background jobs that keep running while read-only; absent means the defaults. */
  keepRunningJobs?: string[];
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
  providerCapacity: StoredProviderCapacitySettings;
  maintenance: StoredMaintenanceSettings;
}

/**
 * Settings change rarely and are read on nearly every request, so they are
 * cached. A change clears this process's copy at once and every other
 * replica's over Redis (`settingsChanged`, services/cache-bus; v0.11 item 20).
 * The TTL stays as the fallback: without Redis, or while it is away, a change
 * reaches the other replicas within it.
 */
const CACHE_TTL_MS = 30_000;

const cache = new Map<SettingKey, { value: unknown; expiresAt: number }>();

/**
 * Bumped by every invalidation. A read that started before one does not cache
 * what it read: it may be the value from before the change, and caching it
 * would keep it for the whole TTL after the invalidation was heard.
 */
let generation = 0;

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value as SettingsMap[K];
  const readGeneration = generation;

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
  if (readGeneration === generation)
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

  generation++;
  cache.set(key, { value: next, expiresAt: Date.now() + CACHE_TTL_MS });
  await publishInvalidation('settings', key);
  return next;
}

/** Forgets this process's copy (all of it without a key). Other replicas keep theirs. */
export function invalidateSettingsCache(key?: SettingKey): void {
  generation++;
  if (key) cache.delete(key);
  else cache.clear();
}

/**
 * After a setting was written other than through `updateSetting` (inside a
 * transaction, say), once it is committed: forgets it here and on every other
 * replica.
 */
export async function settingsChanged(key: SettingKey): Promise<void> {
  invalidateSettingsCache(key);
  await publishInvalidation('settings', key);
}

onCacheInvalidation('settings', (key) => invalidateSettingsCache(key as SettingKey | undefined));
