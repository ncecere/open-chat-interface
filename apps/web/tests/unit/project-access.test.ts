import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/lib/api-client';
import {
  accessLabel,
  accessOf,
  describeShareError,
  projectControls,
  shareErrorReason,
} from '../../src/lib/project-access';

describe('what each access level may do (the matrix of SPEC-groups.md)', () => {
  // The server is the boundary; this is what the page hides because the API would refuse.
  it.each([
    [
      'owner',
      {
        rename: true,
        editInstructions: true,
        manageFiles: true,
        share: true,
        transfer: true,
        remove: true,
        leave: false,
      },
    ],
    [
      'editor',
      {
        rename: false,
        editInstructions: true,
        manageFiles: true,
        share: false,
        transfer: false,
        remove: false,
        leave: true,
      },
    ],
    [
      'viewer',
      {
        rename: false,
        editInstructions: false,
        manageFiles: false,
        share: false,
        transfer: false,
        remove: false,
        leave: true,
      },
    ],
  ] as const)('%s', (access, expected) => {
    expect(projectControls(access)).toEqual(expected);
  });

  it('reads a project from an older API, which sends no access, as the caller’s own', () => {
    expect(accessOf({})).toBe('owner');
    expect(accessOf({ access: 'viewer' })).toBe('viewer');
  });

  it('names each level in plain words', () => {
    expect(accessLabel('owner')).toBe('Owner');
    expect(accessLabel('editor')).toBe('Editor');
    expect(accessLabel('viewer')).toBe('Viewer');
  });
});

describe('what a refused share says', () => {
  const refusal = (
    status: number,
    code: string,
    message: string,
    reason?: string,
    retry?: number,
  ) => new ApiError(status, code, message, reason ? { reason } : undefined, retry);

  it('finds the reason the API gave, and only a known one', () => {
    expect(shareErrorReason(refusal(409, 'CONFLICT', 'x', 'already_shared'))).toBe(
      'already_shared',
    );
    expect(shareErrorReason(refusal(409, 'CONFLICT', 'x', 'something_new'))).toBeUndefined();
    expect(shareErrorReason(new Error('x'))).toBeUndefined();
  });

  it.each([
    [
      refusal(429, 'RATE_LIMITED', 'Too many', undefined, 12),
      'Too many sharing attempts. Try again in 12 seconds.',
    ],
    [
      refusal(429, 'RATE_LIMITED', 'Too many'),
      'Too many sharing attempts. Wait a moment and try again.',
    ],
    [
      refusal(422, 'VALIDATION_FAILED', 'No account', 'person_not_found'),
      'No account has that email address. It has to match exactly.',
    ],
    [
      refusal(404, 'NOT_FOUND', 'Not found'),
      'That person could not be found, or you can no longer share this project.',
    ],
    [
      refusal(
        409,
        'CONFLICT',
        'An upgrade is still in progress. Try again when it has finished.',
        'upgrade_in_progress',
      ),
      'An upgrade is still in progress. Try again when it has finished.',
    ],
    [
      refusal(409, 'CONFLICT', 'Already shared', 'already_shared'),
      'This project is already shared with them. Change their access in the list below.',
    ],
    [
      refusal(
        422,
        'VALIDATION_FAILED',
        'A project can be shared with at most 50 people or groups.',
        'share_limit',
      ),
      'A project can be shared with at most 50 people or groups.',
    ],
  ])('words %#', (error, text) => {
    expect(describeShareError(error, 'fallback')).toBe(text);
  });

  it('falls back for anything that is not an API error', () => {
    expect(describeShareError(new Error('boom'), 'The project could not be shared.')).toBe(
      'The project could not be shared.',
    );
  });
});
