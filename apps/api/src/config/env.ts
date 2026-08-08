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
  REDIS_URL: z.string().optional(),
  CHAT_STREAM_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

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
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
