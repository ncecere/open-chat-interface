import { describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/index.js', () => ({ auth: { api: { getSession: vi.fn() } } }));

import { roles } from '../../auth/permissions.js';
import { normalizeSessionRole } from '../../middleware/context.js';

describe('unit: role normalization and permission statements', () => {
  it.each(['admin', 'user', 'restricted'] as const)('keeps the supported %s role', (role) => {
    expect(normalizeSessionRole(role)).toBe(role);
  });

  it.each(['owner', 'superadmin', 'User', '', 1, {}, false, undefined, null])(
    'fails closed for unexpected persisted role %j',
    (role) => {
      expect(normalizeSessionRole(role)).toBe('restricted');
    },
  );

  it('does not grant restricted users sharing, temporary-chat, persona, or upload rights', () => {
    expect(roles.restricted.statements).toEqual({ model: ['read'], thread: ['create'] });
  });

  it('does not grant ordinary users administrative resources', () => {
    expect(roles.user.statements).not.toHaveProperty('provider');
    expect(roles.user.statements).not.toHaveProperty('quota');
    expect(roles.user.statements).not.toHaveProperty('audit');
    expect(roles.user.statements).not.toHaveProperty('user');
  });
});
