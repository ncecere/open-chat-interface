import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';

/**
 * OCI permission statements. The UI exposes three role presets, but access is
 * enforced per statement so finer-grained roles can be added without a rewrite.
 */
export const statement = {
  ...defaultStatements,
  instance: ['read', 'configure'],
  provider: ['read', 'manage'],
  model: ['read', 'manage'],
  invite: ['read', 'manage'],
  sso: ['read', 'manage'],
  quota: ['read', 'manage'],
  audit: ['read'],
  analytics: ['read'],
  thread: ['create', 'share', 'temporary'],
  persona: ['manage'],
  attachment: ['upload'],
} as const;

export const ac = createAccessControl(statement);

export const roles = {
  admin: ac.newRole({
    ...adminAc.statements,
    instance: ['read', 'configure'],
    provider: ['read', 'manage'],
    model: ['read', 'manage'],
    invite: ['read', 'manage'],
    sso: ['read', 'manage'],
    quota: ['read', 'manage'],
    audit: ['read'],
    analytics: ['read'],
    thread: ['create', 'share', 'temporary'],
    persona: ['manage'],
    attachment: ['upload'],
  }),
  user: ac.newRole({
    model: ['read'],
    thread: ['create', 'share', 'temporary'],
    persona: ['manage'],
    attachment: ['upload'],
  }),
  restricted: ac.newRole({
    model: ['read'],
    thread: ['create'],
  }),
};
