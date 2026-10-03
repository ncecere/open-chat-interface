/**
 * Legal hold messages and the trigger's error code, without database imports,
 * so the error handler can recognise a refused deletion.
 */

/** SQLSTATE raised by the `legal_hold_guard_user_delete` trigger. */
export const LEGAL_HOLD_SQLSTATE = 'OCLH1';

export const HELD_ACCOUNT_DELETION_MESSAGE =
  'This person is on legal hold, so their account cannot be deleted. Lift the hold under Data & storage → Compliance first.';

export const HELD_PERMANENT_DELETION_MESSAGE =
  'Permanent deletion is paused for this account by your organization. Deleted conversations stay in the trash.';

/** True for the error the deletion trigger raises, however the driver wraps it. */
export function isLegalHoldViolation(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; cause && typeof cause === 'object' && depth < 5; depth++) {
    if ('code' in cause && cause.code === LEGAL_HOLD_SQLSTATE) return true;
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return false;
}
