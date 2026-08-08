import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  DEFAULT_AUTH_ATTEMPTS_PER_MINUTE,
  DEFAULT_CHAT_REQUESTS_PER_MINUTE,
  DEFAULT_MAX_CONCURRENT_STREAMS,
  DEFAULT_RESERVED_COST_MICROS,
  DEFAULT_RESERVED_TOKENS,
  DEFAULT_TRASH_RETENTION_DAYS,
  DEFAULT_UPLOAD_REQUESTS_PER_MINUTE,
  DEFAULT_USAGE_EVENT_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
  type RateLimitSettings,
  type RetentionSettings,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { loadEnv } from '../../config/env.js';
import { getSetting, updateSetting } from '../settings.js';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Retention configuration. Environment variables supply the starting values;
 * an administrator's saved settings take precedence once written.
 */
export async function getRetentionSettings(): Promise<RetentionSettings> {
  const env = loadEnv();
  const stored = await getSetting('retention');

  const trashDays =
    stored.trashRetentionDays ??
    positiveInt(env.RETENTION_TRASH_DAYS, DEFAULT_TRASH_RETENTION_DAYS);

  return {
    // A floor keeps deletion from being made instantaneous by accident, which
    // would quietly remove the recovery path the trash exists to provide.
    trashRetentionDays: Math.min(
      MAX_TRASH_RETENTION_DAYS,
      Math.max(MIN_TRASH_RETENTION_DAYS, trashDays),
    ),
    threadRetentionDays:
      stored.threadRetentionDays === undefined
        ? positiveInt(env.RETENTION_THREAD_DAYS, 0) || null
        : stored.threadRetentionDays,
    exemptPinnedThreads: stored.exemptPinnedThreads ?? true,
    usageEventRetentionDays:
      stored.usageEventRetentionDays ??
      positiveInt(env.RETENTION_USAGE_EVENT_DAYS, DEFAULT_USAGE_EVENT_RETENTION_DAYS),
    auditLogRetentionDays:
      stored.auditLogRetentionDays ??
      positiveInt(env.RETENTION_AUDIT_LOG_DAYS, DEFAULT_AUDIT_LOG_RETENTION_DAYS),
    displayTimezone: stored.displayTimezone ?? env.DISPLAY_TIMEZONE ?? 'UTC',
  };
}

export async function updateRetentionSettings(
  patch: Partial<RetentionSettings>,
): Promise<RetentionSettings> {
  await updateSetting('retention', patch);
  return getRetentionSettings();
}

export interface RateLimitConfig {
  roles: Record<UserRole, RateLimitSettings>;
  authAttemptsPerMinute: number;
  /**
   * What a reservation holds before real usage is known. Paired with the
   * concurrency cap because together they bound how far simultaneous runs can
   * overshoot a budget: worst case is roughly cap x reserve.
   */
  reserve: { costMicros: number; tokens: number };
}

/** Per-role rate and concurrency limits, with environment-supplied defaults. */
export async function getRateLimitSettings(): Promise<RateLimitConfig> {
  const env = loadEnv();
  const stored = await getSetting('rateLimits');

  const roles = Object.fromEntries(
    USER_ROLES.map((role) => {
      const saved = stored.roles?.[role] ?? {};
      return [
        role,
        {
          maxConcurrentStreams:
            saved.maxConcurrentStreams ??
            positiveInt(
              env.RATE_LIMIT_MAX_CONCURRENT_STREAMS,
              DEFAULT_MAX_CONCURRENT_STREAMS[role],
            ),
          chatRequestsPerMinute:
            saved.chatRequestsPerMinute ??
            positiveInt(env.RATE_LIMIT_CHAT_PER_MINUTE, DEFAULT_CHAT_REQUESTS_PER_MINUTE[role]),
          uploadRequestsPerMinute:
            saved.uploadRequestsPerMinute ??
            positiveInt(env.RATE_LIMIT_UPLOAD_PER_MINUTE, DEFAULT_UPLOAD_REQUESTS_PER_MINUTE[role]),
        },
      ];
    }),
  ) as Record<UserRole, RateLimitSettings>;

  return {
    roles,
    authAttemptsPerMinute:
      stored.authAttemptsPerMinute ??
      positiveInt(env.RATE_LIMIT_AUTH_PER_MINUTE, DEFAULT_AUTH_ATTEMPTS_PER_MINUTE),
    reserve: {
      costMicros:
        stored.reserve?.costMicros ??
        positiveInt(env.QUOTA_RESERVE_COST_MICROS, DEFAULT_RESERVED_COST_MICROS),
      tokens:
        stored.reserve?.tokens ?? positiveInt(env.QUOTA_RESERVE_TOKENS, DEFAULT_RESERVED_TOKENS),
    },
  };
}

/**
 * The zone reporting is presented in.
 *
 * Deliberately separate from a policy's timezone, which governs when a limit
 * actually resets. Enforcement stays per-policy; this only decides where a day
 * boundary falls on a chart, so the two can never be confused for each other.
 */
export async function getDisplayTimezone(): Promise<string> {
  const stored = await getSetting('retention');
  const configured = stored.displayTimezone ?? loadEnv().DISPLAY_TIMEZONE;
  if (!configured) return 'UTC';

  // An unknown zone would make Postgres raise on every reporting query.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured });
    return configured;
  } catch {
    return 'UTC';
  }
}

/** Just the reserve, for the reservation path that needs nothing else. */
export async function getReserveAmounts(): Promise<{ costMicros: number; tokens: number }> {
  return (await getRateLimitSettings()).reserve;
}

export async function updateRateLimitSettings(patch: {
  roles?: Partial<Record<UserRole, Partial<RateLimitSettings>>>;
  authAttemptsPerMinute?: number;
  reserve?: { costMicros?: number; tokens?: number };
}): Promise<RateLimitConfig> {
  const current = await getSetting('rateLimits');
  const roles = { ...current.roles };

  for (const [role, values] of Object.entries(patch.roles ?? {})) {
    roles[role as UserRole] = { ...roles[role as UserRole], ...values };
  }

  await updateSetting('rateLimits', {
    roles,
    ...(patch.authAttemptsPerMinute === undefined
      ? {}
      : { authAttemptsPerMinute: patch.authAttemptsPerMinute }),
    ...(patch.reserve ? { reserve: { ...current.reserve, ...patch.reserve } } : {}),
  });

  return getRateLimitSettings();
}
