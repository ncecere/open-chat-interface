import { type ApiErrorBody, ERROR_CODES } from '@oci/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  MESSAGE_NOT_SENT_TEXT,
  MESSAGE_SAVED_HEADER,
  turnNotSaved,
} from '../services/chat/turn-patience.js';
import {
  HELD_ACCOUNT_DELETION_MESSAGE,
  isLegalHoldViolation,
} from '../services/compliance/hold-errors.js';
import { errors } from '../services/observability/metrics.js';
import { lostConnectionDuring, RETRYABLE_HEADER, RETRYABLE_REASON } from './read-retry.js';

export function errorHandler(error: Error, c: Context): Response {
  const response = answer(error, c);
  // A new message that failed before it could be stored (#326): the browser
  // puts its text back in the message box instead of leaving a "sent" bubble
  // that was never saved.
  if (turnNotSaved(c.req.raw)) response.headers.set(MESSAGE_SAVED_HEADER, 'no');
  return response;
}

function answer(error: Error, c: Context): Response {
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

  // The legal hold trigger refusing an account deletion on a path that did not check first.
  if (isLegalHoldViolation(error)) {
    const body: ApiErrorBody = {
      error: { code: ERROR_CODES.CONFLICT, message: HELD_ACCOUNT_DELETION_MESSAGE },
    };
    return c.json(body, 409);
  }

  // A database failover (v0.11): reads are run again by middleware/read-retry.ts;
  // anything else tells the client it may send the request again.
  if (lostConnectionDuring(c.req.raw, error)) {
    logger.warn(
      { err: error, path: c.req.path, method: c.req.method },
      'Request failed: database connection lost',
    );
    errors.inc({ source: 'database-connection' });
    return c.json(
      {
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: turnNotSaved(c.req.raw)
            ? MESSAGE_NOT_SENT_TEXT
            : 'The connection to the database was interrupted. Try again; if you were saving something, check whether it was saved first.',
          retryable: true,
        },
      },
      500,
      { [RETRYABLE_HEADER]: RETRYABLE_REASON, 'retry-after': '1' },
    );
  }

  logger.error({ err: error, path: c.req.path }, 'Unhandled error');
  errors.inc({ source: 'http' });

  const body: ApiErrorBody = {
    error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'An unexpected error occurred' },
  };
  return c.json(body, 500);
}
