import { logger } from '../lib/logger.js';

type BetterAuthLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Better Auth's `logger.log`: its messages go through the application logger,
 * and so through its redaction (lib/log-redaction.ts), instead of Better
 * Auth's console logger, which printed a failed session lookup's query with
 * the raw session token (#264).
 */
export function logBetterAuth(level: BetterAuthLevel, message: string, ...args: unknown[]): void {
  const err = args.find((arg) => arg instanceof Error);
  const details = args.filter((arg) => arg !== err);
  logger[level](
    {
      component: 'better-auth',
      ...(err ? { err } : {}),
      ...(details.length > 0 ? { details } : {}),
    },
    `Better Auth: ${message}`,
  );
}
