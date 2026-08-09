import { describe, expect, it } from 'vitest';
import { roles } from '../../auth/permissions.js';

/**
 * The auditor role exists so a compliance reviewer needs no write access.
 * These check the shape of the grant rather than the middleware, which is
 * covered by the live suite.
 */
describe('auditor role', () => {
  const auditorStatements = roles.auditor.statements as Record<string, readonly string[]>;
  const adminStatements = roles.admin.statements as Record<string, readonly string[]>;

  it('grants no administrative statement beyond reading', () => {
    const administrative = ['instance', 'provider', 'model', 'invite', 'sso', 'quota'];

    for (const resource of administrative) {
      expect(auditorStatements[resource], resource).toEqual(['read']);
    }
  });

  it('can read the audit log and analytics', () => {
    expect(auditorStatements.audit).toContain('read');
    expect(auditorStatements.analytics).toContain('read');
  });

  it('never receives a manage or configure statement', () => {
    const granted = Object.values(auditorStatements).flat();
    expect(granted).not.toContain('manage');
    expect(granted).not.toContain('configure');
  });

  it('reads everywhere an administrator can', () => {
    // A reviewer who cannot see a surface cannot review it, so any read an
    // administrator holds should be held here too.
    for (const [resource, actions] of Object.entries(adminStatements)) {
      if (!actions.includes('read')) continue;
      expect(auditorStatements[resource], resource).toContain('read');
    }
  });

  it('still uses the application as a person', () => {
    // An auditor is a human with an account, not a service principal.
    expect(auditorStatements.thread).toContain('create');
  });
});
