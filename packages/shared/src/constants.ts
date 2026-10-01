export const APP_NAME = 'Open Chat Interface';
export const APP_SHORT_NAME = 'OCI';

export const USER_ROLES = ['admin', 'auditor', 'user', 'restricted'] as const;
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

export const REASONING_EFFORTS = ['instant', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Accent families layered over the shared neutral surface palette. */
export const COLOR_THEMES = ['neutral', 'blue', 'violet', 'emerald'] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];

export const SEARCH_PROVIDER_KINDS = ['searxng', 'tavily', 'brave', 'exa'] as const;
export type SearchProviderKind = (typeof SEARCH_PROVIDER_KINDS)[number];

export const STORAGE_DRIVERS = ['local', 's3'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/** What a quota policy counts. */
export const QUOTA_METRICS = ['messages', 'tokens', 'cost'] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

/**
 * `rolling` looks back a fixed number of hours. The calendar kinds reset at
 * midnight in the policy's timezone.
 */
export const QUOTA_WINDOW_KINDS = ['rolling', 'daily', 'weekly', 'monthly'] as const;
export type QuotaWindowKind = (typeof QUOTA_WINDOW_KINDS)[number];

/** Money is stored as integer micro-dollars so no amount is ever a float. */
export const MICROS_PER_DOLLAR = 1_000_000;
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_FILES_PER_MESSAGE = 10;

/**
 * What a reservation holds before real usage is known. One message is exact;
 * spend and tokens are not, so a flat amount is reserved and settled to actual
 * when the run ends. Combined with the concurrency cap this bounds how far a
 * budget can be overshot by simultaneous runs.
 */
export const DEFAULT_RESERVED_COST_MICROS = 250_000;
export const DEFAULT_RESERVED_TOKENS = 4_000;

/** Fractions of an allowance at which the usage meter warns. */
export const USAGE_WARNING_THRESHOLD = 0.8;
export const USAGE_CRITICAL_THRESHOLD = 0.95;

/** Trash retention. A floor keeps an operator from making deletion instant. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export const MIN_TRASH_RETENTION_DAYS = 1;
export const MAX_TRASH_RETENTION_DAYS = 365;

/**
 * Usage history. Events are the hot table quota evaluation reads; the daily
 * rollup is small enough to keep for years.
 */
export const DEFAULT_USAGE_EVENT_RETENTION_DAYS = 90;
export const DEFAULT_AUDIT_LOG_RETENTION_DAYS = 365;

/**
 * Audit actions kept regardless of retention. These are the entries an
 * incident review needs, and they are low volume.
 */
export const PROTECTED_AUDIT_ACTIONS = [
  'user.create',
  'user.update',
  'user.delete',
  'user.role.change',
  // Bulk access changes name every affected account in one entry.
  'user.bulk.set_role',
  'user.bulk.ban',
  'user.bulk.unban',
  'provider.create',
  'provider.update',
  'provider.delete',
  'sso.create',
  'sso.update',
  'sso.delete',
  'settings.auth.update',
] as const;

/** Rate limiting and concurrency defaults, overridable per role by an admin. */
export const DEFAULT_MAX_CONCURRENT_STREAMS: Record<UserRole, number> = {
  admin: 10,
  auditor: 3,
  user: 3,
  restricted: 1,
};

export const DEFAULT_CHAT_REQUESTS_PER_MINUTE: Record<UserRole, number> = {
  admin: 120,
  auditor: 30,
  user: 30,
  restricted: 10,
};

export const DEFAULT_UPLOAD_REQUESTS_PER_MINUTE: Record<UserRole, number> = {
  admin: 120,
  auditor: 20,
  user: 20,
  restricted: 5,
};

/** Auth endpoints are brute-force surfaces, limited per IP and per account. */
export const DEFAULT_AUTH_ATTEMPTS_PER_MINUTE = 10;

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
