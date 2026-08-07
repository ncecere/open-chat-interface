import { ERROR_CODES, type ErrorCode } from '@oci/shared';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: ContentfulStatusCode,
    readonly details?: unknown,
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

export const providerError = (message: string) =>
  new AppError(ERROR_CODES.PROVIDER_ERROR, message, 502);
