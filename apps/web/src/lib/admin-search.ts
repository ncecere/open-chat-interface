import { USER_ROLES } from '@oci/shared';
/**
 * Search-param schemas for admin pages whose tabs live in the URL.
 *
 * Kept outside routes/admin so the router can validate search params without
 * pulling deferred admin page code into the initial bundle. Defaults are
 * omitted from the URL, so every field is optional and links need no search.
 */

export const USAGE_TABS = ['overview', 'spend', 'limits', 'storage'] as const;
export type UsageTab = (typeof USAGE_TABS)[number];
export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export const DEFAULT_USAGE_TAB: UsageTab = 'overview';
export const DEFAULT_USAGE_RANGE: UsageRange = 30;

export const STORAGE_TABS = ['driver', 's3', 'uploads'] as const;
export type StorageTab = (typeof STORAGE_TABS)[number];
export const DEFAULT_STORAGE_TAB: StorageTab = 'driver';

/** Mirrors USER_ROLES; kept local so the router does not pull in the shared package. */
export const ROLE_TABS = ['admin', 'auditor', 'user', 'restricted'] as const;
export type RoleTab = (typeof ROLE_TABS)[number];
export const DEFAULT_ROLE_TAB: RoleTab = 'user';

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[]): T | undefined {
  // The default parser turns `?range=30` into a number; a hand-typed URL may
  // still deliver a string, so compare by string form.
  return allowed.find((option) => String(option) === String(value));
}

export interface UsageSearch {
  tab?: UsageTab;
  range?: UsageRange;
}

export function validateUsageSearch(search: Record<string, unknown>): UsageSearch {
  const tab = oneOf(search.tab, USAGE_TABS);
  const range = oneOf(search.range, USAGE_RANGES);
  return {
    ...(tab && tab !== DEFAULT_USAGE_TAB ? { tab } : {}),
    ...(range && range !== DEFAULT_USAGE_RANGE ? { range } : {}),
  };
}

export interface StorageSearch {
  tab?: StorageTab;
}

export function validateStorageSearch(search: Record<string, unknown>): StorageSearch {
  const tab = oneOf(search.tab, STORAGE_TABS);
  return tab && tab !== DEFAULT_STORAGE_TAB ? { tab } : {};
}

export interface RolesSearch {
  role?: RoleTab;
}

export function validateRolesSearch(search: Record<string, unknown>): RolesSearch {
  const role = oneOf(search.role, ROLE_TABS);
  return role && role !== DEFAULT_ROLE_TAB ? { role } : {};
}

export interface UsersSearch {
  role?: (typeof USER_ROLES)[number];
}

/** Lets other pages open the user list already filtered to one role. */
export function validateUsersSearch(search: Record<string, unknown>): UsersSearch {
  const role = oneOf(search.role, USER_ROLES);
  return role ? { role } : {};
}
