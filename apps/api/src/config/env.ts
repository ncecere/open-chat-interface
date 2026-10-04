import { DEFAULT_IMPORT_MAX_UPLOAD_BYTES } from '@oci/shared';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:5173'),
  AUTH_TRUSTED_ORIGINS: z.string().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /**
   * Whether this process applies migrations at startup. Set false when a
   * separate migration job owns schema changes, which is the usual pattern
   * once more than one API replica runs.
   */
  RUN_MIGRATIONS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * Lock-safe migrations (v0.11). Each migration statement may wait this long
   * for a lock before the attempt rolls back and is retried, so a blocked
   * migration never queues readers behind it for longer. The migrator reads
   * these itself (packages/db/src/migration-safety.ts, same bounds); they are
   * declared here so a bad value fails at startup.
   */
  MIGRATION_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(3_000),
  /** Per-statement limit for migrations; 0 disables it. Default 15 minutes. */
  MIGRATION_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(86_400_000).default(900_000),
  REDIS_URL: z.string().optional(),
  CHAT_STREAM_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  /**
   * Draining on shutdown (v0.11). After SIGTERM a replica reports not-ready,
   * refuses new chat turns and lets replies in progress finish for up to this
   * long; past it, each remaining reply is saved as interrupted. Set it below
   * the orchestrator's grace period (Kubernetes terminationGracePeriodSeconds,
   * Compose stop_grace_period), leaving a few seconds for the final saves.
   */
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().min(0).max(3_600_000).default(25_000),

  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 characters'),

  INITIAL_ADMIN_EMAIL: z.string().email().optional(),
  INITIAL_ADMIN_PASSWORD: z.string().min(12).optional(),

  STORAGE_LOCAL_PATH: z.string().default('./data/storage'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Retention and rate-limit defaults. These seed the values an administrator
   * sees; anything saved in the admin dashboard takes precedence.
   */
  RETENTION_TRASH_DAYS: z.string().optional(),
  RETENTION_THREAD_DAYS: z.string().optional(),
  RETENTION_USAGE_EVENT_DAYS: z.string().optional(),
  RETENTION_AUDIT_LOG_DAYS: z.string().optional(),
  RATE_LIMIT_MAX_CONCURRENT_STREAMS: z.string().optional(),
  RATE_LIMIT_CHAT_PER_MINUTE: z.string().optional(),
  RATE_LIMIT_UPLOAD_PER_MINUTE: z.string().optional(),
  RATE_LIMIT_AUTH_PER_MINUTE: z.string().optional(),
  QUOTA_RESERVE_COST_MICROS: z.string().optional(),
  QUOTA_RESERVE_TOKENS: z.string().optional(),
  /** IANA zone used to present usage reporting. Enforcement is unaffected. */
  DISPLAY_TIMEZONE: z.string().optional(),
  /** Largest ChatGPT or Claude export a person may upload for import. */
  IMPORT_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_IMPORT_MAX_UPLOAD_BYTES),

  /**
   * Observability (v0.9). `/metrics` is served only when a scrape token is
   * set, and requires it as a Bearer token. Traces are exported over OTLP/HTTP
   * only when an endpoint is set; the SDK is not loaded otherwise.
   */
  METRICS_TOKEN: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined))
    .refine((value) => value === undefined || value.length >= 16, {
      message: 'METRICS_TOKEN must be at least 16 characters',
    }),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? value.trim() : undefined))
    .refine((value) => value === undefined || /^https?:\/\/[^\s]+$/i.test(value), {
      message: 'OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL',
    }),
  OTEL_SERVICE_NAME: z.string().trim().min(1).default('oci-api'),
  /** Directory holding pg_dump and pg_restore; found on PATH when unset. */
  BACKUP_PG_BIN_DIR: z.string().trim().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Variables that must be set to something real. A blank value is passed to
 * validation as it is, so it fails with the variable's own message.
 */
const REQUIRED = new Set(['DATABASE_URL', 'AUTH_SECRET', 'ENCRYPTION_KEY']);

/**
 * Drops blank optional variables, so they read as unset.
 *
 * Docker Compose passes `NAME: ${NAME:-}` through as an empty string, so a
 * variable the operator never set arrives as "" rather than missing. For an
 * optional setting that means "not set": the default applies, and leaving
 * INITIAL_ADMIN_PASSWORD out prints a one-time password as documented.
 */
function withoutBlankOptionals(source: Record<string, string | undefined>) {
  const result: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() === '' && !REQUIRED.has(name)) continue;
    result[name] = value;
  }
  return result;
}

/** Validates an environment; exported for tests, which pass their own. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(withoutBlankOptionals(source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  cached = parseEnv(process.env);
  return cached;
}
