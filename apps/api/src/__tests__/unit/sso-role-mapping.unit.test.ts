import type { ClaimRoleMapping } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { matchRoleFromClaims, resolveRoleFromClaims } from '../../auth/provisioning.js';

const mapping = (
  claim: string,
  value: string,
  role: ClaimRoleMapping['role'],
): ClaimRoleMapping => ({
  claim,
  value,
  role,
});

/**
 * This decides who becomes an administrator on the strength of an assertion
 * from an external identity provider, so the matching rules deserve to be
 * pinned down precisely rather than inferred from behaviour.
 */
describe('SSO role mapping', () => {
  it('falls back to the default role when nothing matches', () => {
    expect(
      resolveRoleFromClaims(
        { groups: ['everyone'] },
        [mapping('groups', 'staff', 'admin')],
        'user',
      ),
    ).toBe('user');
  });

  it('falls back when the provider sends no claims at all', () => {
    expect(resolveRoleFromClaims(undefined, [mapping('groups', 'staff', 'admin')], 'user')).toBe(
      'user',
    );
  });

  it('matches a scalar claim', () => {
    expect(
      resolveRoleFromClaims({ department: 'IT' }, [mapping('department', 'IT', 'admin')], 'user'),
    ).toBe('admin');
  });

  it('matches one entry of a group array', () => {
    // Group membership arrives as an array far more often than as a scalar.
    expect(
      resolveRoleFromClaims(
        { groups: ['everyone', 'oci-admins', 'vpn'] },
        [mapping('groups', 'oci-admins', 'admin')],
        'user',
      ),
    ).toBe('admin');
  });

  it('reads a nested claim through a dotted path', () => {
    // Some OIDC providers nest group membership.
    expect(
      resolveRoleFromClaims(
        { attributes: { groups: ['oci-admins'] } },
        [mapping('attributes.groups', 'oci-admins', 'admin')],
        'user',
      ),
    ).toBe('admin');
  });

  it('prefers a literal claim name over a dotted path', () => {
    // A provider may genuinely send a claim whose name contains a dot.
    expect(
      resolveRoleFromClaims(
        { 'http://schemas.example/role': 'admins', http: { schemas: {} } },
        [mapping('http://schemas.example/role', 'admins', 'admin')],
        'user',
      ),
    ).toBe('admin');
  });

  it('ignores casing, which directories are inconsistent about', () => {
    expect(
      resolveRoleFromClaims(
        { groups: ['OCI-Admins'] },
        [mapping('groups', 'oci-admins', 'admin')],
        'user',
      ),
    ).toBe('admin');
  });

  it('ignores surrounding whitespace', () => {
    expect(
      resolveRoleFromClaims(
        { groups: [' oci-admins '] },
        [mapping('groups', 'oci-admins', 'admin')],
        'user',
      ),
    ).toBe('admin');
  });

  it('grants the most privileged matching role regardless of order', () => {
    const claims = { groups: ['staff', 'oci-admins'] };
    const staffFirst = [
      mapping('groups', 'staff', 'user'),
      mapping('groups', 'oci-admins', 'admin'),
    ];
    const adminFirst = [
      mapping('groups', 'oci-admins', 'admin'),
      mapping('groups', 'staff', 'user'),
    ];

    // Row order is an authoring detail and must not change the outcome.
    expect(resolveRoleFromClaims(claims, staffFirst, 'restricted')).toBe('admin');
    expect(resolveRoleFromClaims(claims, adminFirst, 'restricted')).toBe('admin');
  });

  it('prefers user over restricted when both match', () => {
    expect(
      resolveRoleFromClaims(
        { groups: ['limited', 'staff'] },
        [mapping('groups', 'limited', 'restricted'), mapping('groups', 'staff', 'user')],
        'restricted',
      ),
    ).toBe('user');
  });

  it('never grants a role outside the known set', () => {
    expect(
      resolveRoleFromClaims(
        { groups: ['anything'] },
        [mapping('groups', 'anything', 'superuser' as never)],
        'restricted',
      ),
    ).toBe('restricted');
  });

  it('does not match an empty expected value against a missing claim', () => {
    // Otherwise a half-filled mapping row would silently grant its role.
    expect(resolveRoleFromClaims({}, [mapping('groups', '', 'admin')], 'restricted')).toBe(
      'restricted',
    );
  });

  it('does not treat a null claim as a match', () => {
    expect(resolveRoleFromClaims({ groups: null }, [mapping('groups', '', 'admin')], 'user')).toBe(
      'user',
    );
  });
});

describe('matchRoleFromClaims', () => {
  const mappings: ClaimRoleMapping[] = [
    { claim: 'groups', value: 'oci-users', role: 'user' },
    { claim: 'groups', value: 'oci-admins', role: 'admin' },
  ];

  it('reports no match when the claims carry none of the mapped groups', () => {
    expect(matchRoleFromClaims({ groups: ['finance'] }, mappings)).toBeNull();
  });

  it('reports no match when there are no mappings to match against', () => {
    expect(matchRoleFromClaims({ groups: ['oci-users'] }, [])).toBeNull();
  });

  it('reports no match when the assertion carries no claims at all', () => {
    expect(matchRoleFromClaims(undefined, mappings)).toBeNull();
  });

  it('returns the matched role', () => {
    expect(matchRoleFromClaims({ groups: ['oci-users'] }, mappings)).toBe('user');
  });

  it('applies an auditor mapping, ranked between admin and user', () => {
    const withAuditor: ClaimRoleMapping[] = [
      ...mappings,
      { claim: 'groups', value: 'oci-auditors', role: 'auditor' },
    ];
    expect(matchRoleFromClaims({ groups: ['oci-auditors'] }, withAuditor)).toBe('auditor');
    expect(matchRoleFromClaims({ groups: ['oci-auditors', 'oci-users'] }, withAuditor)).toBe(
      'auditor',
    );
    expect(matchRoleFromClaims({ groups: ['oci-auditors', 'oci-admins'] }, withAuditor)).toBe(
      'admin',
    );
  });

  it('distinguishes an unmatched login from one matching a default-valued rule', () => {
    // This is the distinction the refusal depends on: resolveRoleFromClaims
    // answers "user" for both, having already substituted the default.
    expect(resolveRoleFromClaims({ groups: ['finance'] }, mappings, 'user')).toBe('user');
    expect(resolveRoleFromClaims({ groups: ['oci-users'] }, mappings, 'user')).toBe('user');

    expect(matchRoleFromClaims({ groups: ['finance'] }, mappings)).toBeNull();
    expect(matchRoleFromClaims({ groups: ['oci-users'] }, mappings)).toBe('user');
  });
});
