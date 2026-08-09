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
    attachment: ['upload'],
  }),
  /**
   * Read-only administration, for somebody who reviews an instance without
   * running it.
   *
   * Holds every `read` statement an administrator has and none that manage,
   * so a compliance reviewer needs no write access to do their job. Enforced
   * by request method rather than per route, since a list of forty-nine
   * mutating endpoints is a list somebody will eventually forget to extend.
   */
  auditor: ac.newRole({
    instance: ['read'],
    provider: ['read'],
    model: ['read'],
    invite: ['read'],
    sso: ['read'],
    quota: ['read'],
    audit: ['read'],
    analytics: ['read'],
    thread: ['create', 'share', 'temporary'],
    attachment: ['upload'],
  }),
  user: ac.newRole({
    model: ['read'],
    thread: ['create', 'share', 'temporary'],
    attachment: ['upload'],
  }),
  restricted: ac.newRole({
    model: ['read'],
    thread: ['create'],
  }),
};
