import { ERROR_CODES, type ErrorCode } from '@oci/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: ContentfulStatusCode,
    readonly details?: unknown,
    /** Seconds to advertise in Retry-After for throttled responses. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthorized = (message = 'Authentication required') =>
  new AppError(ERROR_CODES.UNAUTHORIZED, message, 401);

export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(ERROR_CODES.FORBIDDEN, message, 403);

export const notFound = (message = 'Not found') =>
  new AppError(ERROR_CODES.NOT_FOUND, message, 404);

export const conflict = (message: string) => new AppError(ERROR_CODES.CONFLICT, message, 409);

export const validationFailed = (message: string, details?: unknown) =>
  new AppError(ERROR_CODES.VALIDATION_FAILED, message, 422, details);

export const quotaExceeded = (message: string) =>
  new AppError(ERROR_CODES.QUOTA_EXCEEDED, message, 429);

/**
 * Distinct from quotaExceeded: this means too fast, not too much. The client
 * should retry, whereas an exceeded quota needs the window to roll over.
 */
export const rateLimited = (message: string, retryAfterSeconds?: number) =>
  new AppError(ERROR_CODES.RATE_LIMITED, message, 429, undefined, retryAfterSeconds);

export const providerError = (message: string) =>
  new AppError(ERROR_CODES.PROVIDER_ERROR, message, 502);
