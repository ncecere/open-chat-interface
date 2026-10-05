import type { QuotaMetric, QuotaWindowKind } from './constants.js';

/**
 * What people are told about a usage limit (#93). A policy's name is for
 * administrators ("Walk AP race policy (users, non-biting)") and never shown
 * to the person it limits; they see what is counted and over what window.
 * Spend is "usage": instance cost is not something a person is shown.
 */
export function quotaLimitName(metric: QuotaMetric): string {
  switch (metric) {
    case 'messages':
      return 'message limit';
    case 'tokens':
      return 'token limit';
    default:
      return 'usage limit';
  }
}

/** "today", "this week", "the last 24 hours". */
export function quotaWindowPhrase(windowKind: QuotaWindowKind, windowHours: number | null): string {
  switch (windowKind) {
    case 'rolling':
      return `the last ${windowHours ?? 24} hours`;
    case 'daily':
      return 'today';
    case 'weekly':
      return 'this week';
    case 'monthly':
      return 'this month';
    default:
      return 'this window';
  }
}
