export const APP_NAME = 'Open Chat Interface';
export const APP_SHORT_NAME = 'OCI';

export const USER_ROLES = ['admin', 'auditor', 'user', 'restricted'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Who sees a newly added model unless the administrator chooses otherwise:
 * everyone who chats. Auditors review the instance and see no models by
 * default (docs/admin/models-providers.md).
 */
export const DEFAULT_MODEL_ROLES = [
  'admin',
  'user',
  'restricted',
] as const satisfies readonly UserRole[];

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

export const SEARCH_PROVIDER_KINDS = [
  'searxng',
  'tavily',
  'brave',
  'exa',
  'serpapi',
  'searchapi',
] as const;
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
/**
 * The largest instance upload limit an administrator can save: 1 GiB, the same
 * ceiling as a role's per-file storage allowance, so a role that falls back to
 * the instance limit cannot end up with more (#142). Uploads are read into
 * memory, so a multi-gigabyte limit was never workable anyway.
 */
export const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_FILES_PER_MESSAGE = 10;
/**
 * The most files one message (or one project upload) may carry (#218). The
 * upload routes size their request-body limit as file size × file count, so
 * an unbounded count made that limit terabytes; and a model is rarely given
 * more than a handful of files at once. Twice the default.
 */
export const MAX_FILES_PER_MESSAGE = 20;
/**
 * The most results a web search asks its provider for (#218): Brave and
 * Tavily accept at most 20, and search already requested no more than this
 * whatever was saved, so a larger value only misled.
 */
export const MAX_SEARCH_RESULTS = 20;

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
 * How usage reports name the usage of deleted accounts, which is kept without
 * the person (v0.10): one row wherever a list names people.
 */
export const DELETED_ACCOUNTS_LABEL = 'Deleted accounts';

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
  // Connectors hold credentials for systems outside OCI.
  'connector.create',
  'connector.update',
  'connector.delete',
  'sso.create',
  'sso.update',
  'sso.delete',
  'settings.auth.update',
  // Webhooks send audit events outside OCI; backups copy all of its data.
  'webhook.create',
  'webhook.update',
  'webhook.delete',
  'webhook.rotate',
  'backup.settings.update',
  // Compliance export copies audit events (and possibly content) outside OCI;
  // legal holds decide what retention and deletion may remove.
  'compliance.settings.update',
  'compliance.hold.place',
  'compliance.hold.lift',
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
