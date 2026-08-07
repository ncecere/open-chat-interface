import { and, eq, schema } from '@oci/db';
import { db } from '../db/index.js';
import { getDefaultOrganizationId } from './organization.js';

export type SettingKey = 'branding' | 'auth' | 'features' | 'storage' | 'search' | 'smtp' | 'chat';

export interface BrandingSettings {
  appName: string;
  logoUrl: string | null;
  accentColor: string | null;
  loginMessage: string | null;
  defaultTheme: 'light' | 'dark' | 'system';
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
  personas: boolean;
  branching: boolean;
}

export interface StorageSettings {
  driver: 'local' | 's3';
  maxFileBytes: number;
  maxFilesPerMessage: number;
  allowedMimeTypes: string[];
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

interface SettingsMap {
  branding: BrandingSettings;
  auth: AuthSettings;
  features: FeatureSettings;
  storage: StorageSettings;
  search: SearchSettings;
  smtp: SmtpSettings;
  chat: ChatSettings;
}

const cache = new Map<SettingKey, unknown>();

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
  const cached = cache.get(key);
  if (cached) return cached as SettingsMap[K];

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

  const value = (row?.value ?? {}) as unknown as SettingsMap[K];
  cache.set(key, value);
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

  cache.set(key, next);
  return next;
}

export function invalidateSettingsCache(key?: SettingKey): void {
  if (key) cache.delete(key);
  else cache.clear();
}
