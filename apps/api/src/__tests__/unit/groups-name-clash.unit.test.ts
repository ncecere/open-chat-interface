import { describe, expect, it } from 'vitest';
import { isNameClash } from '../../services/groups/name-clash.js';

const clash = { code: '23505', constraint_name: 'group_name_unique' };

/**
 * The unique-name violation can reach the service as the driver's own error or wrapped as the
 * `cause` of the query library's error. Which one depends on where the statement failed, so the
 * concurrent-create tests do not reliably reach both; this covers every shape directly.
 */
describe('isNameClash', () => {
  it('recognises the violation as the error itself', () => {
    expect(isNameClash(clash)).toBe(true);
  });

  it('recognises it wrapped, however deep', () => {
    expect(isNameClash({ message: 'Failed query', cause: clash })).toBe(true);
    expect(isNameClash({ cause: { cause: { cause: clash } } })).toBe(true);
  });

  it('is false for another constraint, another error code, or a partial match', () => {
    expect(isNameClash({ code: '23505', constraint_name: 'some_other_unique' })).toBe(false);
    expect(isNameClash({ code: '40001', constraint_name: 'group_name_unique' })).toBe(false);
    expect(isNameClash({ code: '23505' })).toBe(false);
    expect(isNameClash({ constraint_name: 'group_name_unique' })).toBe(false);
  });

  it('is false for an error with no cause, and for things that are not errors', () => {
    expect(isNameClash(new Error('connection reset'))).toBe(false);
    expect(isNameClash({ cause: new Error('connection reset') })).toBe(false);
    for (const value of [null, undefined, 'group_name_unique', 23505, true]) {
      expect(isNameClash(value)).toBe(false);
    }
  });

  it('ends on a cycle instead of looping', () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isNameClash(looped)).toBe(false);
  });
});
