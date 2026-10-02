import { type ApiErrorBody, ERROR_CODES } from '@oci/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { errors } from '../services/observability/metrics.js';

export function errorHandler(error: Error, c: Context): Response {
  if (error instanceof AppError) {
    const body: ApiErrorBody = {
      error: { code: error.code, message: error.message, details: error.details },
    };
    return c.json(
      body,
      error.status,
      error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : undefined,
    );
  }

  if (error instanceof ZodError) {
    const body: ApiErrorBody = {
      error: {
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Request validation failed',
        details: error.issues,
      },
    };
    return c.json(body, 422);
  }

  if (error instanceof HTTPException) {
    const body: ApiErrorBody = {
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: error.message },
    };
    return c.json(body, error.status);
  }

  logger.error({ err: error, path: c.req.path }, 'Unhandled error');
  errors.inc({ source: 'http' });

  const body: ApiErrorBody = {
    error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'An unexpected error occurred' },
  };
  return c.json(body, 500);
}
