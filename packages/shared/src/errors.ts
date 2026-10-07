export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  REGISTRATION_DISABLED: 'REGISTRATION_DISABLED',
  /** Read-only maintenance mode (v0.11): a write refused with 423 Locked. */
  READ_ONLY: 'READ_ONLY',
  /**
   * The published acceptable use policy has not been accepted by this person
   * (#367): a request that uses the instance is refused with 403 until they
   * accept it (POST /api/me/onboarding/accept-policy).
   */
  POLICY_ACCEPTANCE_REQUIRED: 'POLICY_ACCEPTANCE_REQUIRED',
  /**
   * A replica shutting down (v0.11.1): a new chat turn refused with 503 and
   * Retry-After before anything is stored; send it again. Not a fault.
   */
  SERVER_RESTARTING: 'SERVER_RESTARTING',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
