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

export const RATE_LIMIT_TABS = ['roles', 'reservations'] as const;
export type RateLimitTab = (typeof RATE_LIMIT_TABS)[number];
export const DEFAULT_RATE_LIMIT_TAB: RateLimitTab = 'roles';

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

export interface RateLimitSearch {
  tab?: RateLimitTab;
}

export function validateRateLimitSearch(search: Record<string, unknown>): RateLimitSearch {
  const tab = oneOf(search.tab, RATE_LIMIT_TABS);
  return tab && tab !== DEFAULT_RATE_LIMIT_TAB ? { tab } : {};
}
