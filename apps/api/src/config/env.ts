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

  // --- Three-phase migrations (v0.11 design, section 1; docs/OPERATIONS.md) ---
  /**
   * Per-step limit for post-deploy steps (`migrate --post`), which run
   * outside a transaction and may build an index over the largest table
   * without blocking it. Read by packages/db itself; declared here so a bad
   * value fails at startup. 0 disables it. Default four hours.
   */
  POST_MIGRATION_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(14_400_000),
  /**
   * Whether this process applies post-deploy steps and schedules background
   * migrations itself, from a background job. Unset follows RUN_MIGRATIONS: a
   * replica that migrates itself at startup is a single instance, so once it
   * runs, every replica runs this release. With several replicas leave it
   * false and run `migrate --post` after replacing them all.
   */
  RUN_POST_MIGRATIONS: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  /** Whether this process runs background migration batches (default true). */
  BACKGROUND_MIGRATIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * Throttles: batches wait while a standby's replay lag (pg_stat_replication,
   * needs pg_monitor) or the oldest open transaction is over these limits.
   * 0 turns a check off.
   */
  BACKGROUND_MIGRATION_MAX_REPLICATION_LAG_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3_600_000)
    .default(10_000),
  BACKGROUND_MIGRATION_MAX_TRANSACTION_AGE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(300_000),
  /** statement_timeout for one batch's transaction. */
  BACKGROUND_MIGRATION_BATCH_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(30_000),
  /** Test only: test background migrations to enable, comma-separated (packages/db). */
  OCI_TEST_BACKGROUND_MIGRATIONS: z.string().optional(),
  /**
   * Process role (v0.11 design, item 14; docs/OPERATIONS.md, "Process roles").
   *
   * - `all` (default): serves the API and runs background jobs, as before.
   * - `web`: serves the API only. Background work (imports, embeddings,
   *   summaries, webhooks, backups, compliance exports, retention, the
   *   interrupted-reply sweep) is queued for a worker, so a `web`-only
   *   deployment needs at least one `worker` or `all` replica.
   * - `worker`: runs background jobs and serves only /api/health/live,
   *   /api/health/ready and /metrics on API_PORT.
   */
  OCI_ROLE: z.enum(['web', 'worker', 'all']).default('all'),

  // --- Connection pooling and read routing (v0.11 design, section 11) -------
  // docs/OPERATIONS.md, "Connection pooling". DATABASE_URL is the
  // application pool: it may point at a transaction-mode pooler (PgBouncer),
  // because nothing on it keeps session state between transactions.
  /** Connections in the application pool, per replica. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(10),
  /**
   * The control connections: migrations, session advisory locks (background
   * jobs, `migrate --post`), LISTEN (workers) and pg_dump. Must reach
   * PostgreSQL directly or through a session-mode pooler. Defaults to
   * DATABASE_URL, which is right whenever that is not a transaction-mode pooler.
   */
  CONTROL_DATABASE_URL: z.string().optional(),
  /**
   * A streaming replica for heavy administrative reads that tolerate a second
   * of staleness (usage reports, the overview, audit log search and export).
   * Used only while it has replayed what the primary had written
   * READ_DATABASE_MAX_LAG_MS ago; otherwise, and when unset, reads go to the
   * primary. Never used for a person's own data.
   */
  READ_DATABASE_URL: z.string().optional(),
  READ_DATABASE_MAX_LAG_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  READ_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(5),

  // --- Redis high availability (v0.11 design, item 16) ----------------------
  // docs/OPERATIONS.md, "Redis". One of REDIS_URL (one server),
  // REDIS_SENTINELS (Sentinel) or REDIS_CLUSTER_NODES (Redis Cluster); when
  // several are set, Cluster wins over Sentinel over REDIS_URL. Redis is
  // required for more than one replica.
  /** Sentinels, `host:port` separated by commas. */
  REDIS_SENTINELS: z.string().optional(),
  /** The Sentinel master group name. */
  REDIS_SENTINEL_NAME: z.string().trim().min(1).default('mymaster'),
  REDIS_SENTINEL_USERNAME: z.string().optional(),
  REDIS_SENTINEL_PASSWORD: z.string().optional(),
  /** TLS to the sentinels themselves (REDIS_TLS covers the data nodes). */
  REDIS_SENTINEL_TLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Cluster seed nodes, `host:port` separated by commas. */
  REDIS_CLUSTER_NODES: z.string().optional(),
  /** Credentials for Sentinel-managed or Cluster data nodes (REDIS_URL carries its own). */
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  /** TLS to Sentinel-managed or Cluster data nodes (use rediss:// with REDIS_URL). */
  REDIS_TLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** A PEM file of certificate authorities to trust for Redis TLS. */
  REDIS_TLS_CA_FILE: z.string().optional(),
  /** Longest a single Redis command may take before it fails (and Redis is treated as away). */
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),

  // --- Embedding generations (v0.11 design, section 7) ---------------------
  /**
   * How long a replaced embeddings generation is kept after searches move to
   * the new one, before the `embeddings.rebuild` job drops its table.
   */
  EMBEDDING_GENERATION_GRACE_MINUTES: z.coerce.number().int().min(1).max(525_600).default(1_440),
  /** Pause after every 64 passages a rebuild embeds, to spread the provider's load. */
  EMBEDDING_REBUILD_PAUSE_MS: z.coerce.number().int().min(0).max(60_000).default(250),

  // --- Read-only maintenance mode (v0.11 design, section 9) -----------------
  // docs/admin/maintenance.md. For emergencies: on regardless of the
  // administrator's setting, and it cannot be turned off from the UI. Set it
  // on every replica (and worker) at once.
  OCI_READ_ONLY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Shown to people while OCI_READ_ONLY is on. */
  OCI_READ_ONLY_REASON: z.string().trim().max(500).optional(),
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
