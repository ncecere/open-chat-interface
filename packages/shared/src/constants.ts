export const APP_NAME = 'Open Chat Interface';
export const APP_SHORT_NAME = 'OCI';

export const USER_ROLES = ['admin', 'user', 'restricted'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const REGISTRATION_MODES = ['open', 'invite_only', 'closed'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];

export const PROVIDER_KINDS = ['openai', 'anthropic', 'google', 'openai-compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const MODEL_CAPABILITIES = [
  'vision',
  'reasoning',
  'effort_control',
  'tool_calling',
  'image_generation',
  'pdf_comprehension',
  'fast',
  'web_search',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const COST_TIERS = ['free', 'low', 'medium', 'high', 'premium'] as const;
export type CostTier = (typeof COST_TIERS)[number];

export const REASONING_EFFORTS = ['instant', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const SEARCH_PROVIDER_KINDS = ['searxng', 'tavily', 'brave', 'exa'] as const;
export type SearchProviderKind = (typeof SEARCH_PROVIDER_KINDS)[number];

export const STORAGE_DRIVERS = ['local', 's3'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_FILES_PER_MESSAGE = 10;

export const DEFAULT_ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
] as const;
