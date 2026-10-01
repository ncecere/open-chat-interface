import { z } from 'zod';

/**
 * `complete` — configured and usable.
 * `attention` — required, or switched on, but not usable as configured.
 * `optional` — not configured, and nothing depends on it yet.
 */
export const SETUP_CHECK_STATUSES = ['complete', 'attention', 'optional'] as const;
export type SetupCheckStatus = (typeof SETUP_CHECK_STATUSES)[number];

export const SETUP_CHECK_IDS = [
  'provider',
  'models',
  'default-model',
  'sign-in',
  'email',
  'storage',
  'web-search',
  'acceptable-use',
  'redis',
] as const;
export type SetupCheckId = (typeof SETUP_CHECK_IDS)[number];

export const setupCheckSchema = z.object({
  id: z.enum(SETUP_CHECK_IDS),
  title: z.string(),
  status: z.enum(SETUP_CHECK_STATUSES),
  /** Whether the instance is not usable as intended until this is complete. */
  required: z.boolean(),
  /** What is true now, in one sentence; never contains secrets. */
  detail: z.string(),
  /** The admin page that resolves this check. */
  action: z.object({ label: z.string(), to: z.string() }),
});

export const setupStatusSchema = z.object({
  /** Required checks that are complete, out of all required checks. */
  requiredComplete: z.number().int().nonnegative(),
  requiredTotal: z.number().int().nonnegative(),
  checks: z.array(setupCheckSchema),
});

export type SetupCheck = z.infer<typeof setupCheckSchema>;
export type SetupStatus = z.infer<typeof setupStatusSchema>;
