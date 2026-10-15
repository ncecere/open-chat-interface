import type { MfaStatus } from '@oci/shared';
import { ApiError } from '../../src/lib/api-client';

/** `GET /api/me/mfa` for a person with nothing set up, with any field overridden. */
export function mfaStatus(overrides: Partial<MfaStatus> = {}): MfaStatus {
  return {
    eligible: true,
    enrolled: false,
    methods: [],
    recoveryCodesLeft: null,
    required: false,
    deadline: null,
    limited: false,
    passkeys: [],
    lockedUntil: null,
    ...overrides,
  };
}

/** A person with an authenticator, `left` recovery codes and the given passkeys. */
export function enrolledStatus(
  left = 8,
  passkeys: MfaStatus['passkeys'] = [],
  overrides: Partial<MfaStatus> = {},
): MfaStatus {
  return mfaStatus({
    enrolled: true,
    methods: passkeys.length > 0 ? ['totp', 'passkey'] : ['totp'],
    recoveryCodesLeft: left,
    passkeys,
    ...overrides,
  });
}

export const PASSKEY = {
  id: 'pk1',
  name: 'Work laptop',
  createdAt: '2026-09-01T10:00:00.000Z',
  deviceType: 'singleDevice',
  backedUp: false,
};

/** What `/api/me/mfa/*` answers 422 with for a wrong password or code: the field and the message. */
export function fieldRefusal(field: 'password' | 'code', message: string): ApiError {
  return new ApiError(422, 'VALIDATION_FAILED', message, [{ path: [field], message }]);
}

export const RECOVERY_CODES = [
  'aB3dE-fG5hJ',
  'kL7mN-pQ9rS',
  'tU2vW-xY4zA',
  'bC6dE-fH8jK',
  'mN3pQ-rS5tU',
  'vW7xY-zA9bC',
  'dE2fG-hJ4kL',
  'mN6pQ-rT8uV',
  'wX3yZ-aB5cD',
  'eF7gH-jK9mN',
];
