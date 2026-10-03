import { z } from 'zod';
import { REASONING_EFFORTS } from '../constants.js';

/**
 * Settings → Sharing (v0.10): one share link a person made, with the
 * conversation it publishes.
 */
export const myShareLinkSchema = z.object({
  id: z.string(),
  slug: z.string(),
  path: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  /** True while the conversation is in the trash or a temporary chat has expired. */
  threadUnavailable: z.boolean(),
  /** Null for a live link; the last message shown for a snapshot. */
  upToMessageId: z.string().nullable(),
  viewCount: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const MY_SHARE_LINKS_PAGE_SIZE = 50;
export const MY_SHARE_LINKS_MAX_PAGE_SIZE = 100;

export const myShareLinksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MY_SHARE_LINKS_MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const myShareLinksResponseSchema = z.object({
  links: z.array(myShareLinkSchema),
  /** Every link the person has, revoked ones included. */
  total: z.number().int().nonnegative(),
  /** Links that still work or could (not revoked), which Revoke all would revoke. */
  active: z.number().int().nonnegative(),
  /** Offset of the next page, or null on the last. */
  nextOffset: z.number().int().nonnegative().nullable(),
});

export type MyShareLink = z.infer<typeof myShareLinkSchema>;
export type MyShareLinksResponse = z.infer<typeof myShareLinksResponseSchema>;

/**
 * Settings → Models (v0.10): the person's own starting model and reasoning
 * level. Null means "use the instance default". Each is checked against what
 * the person's role allows when saved, and again whenever it is used.
 */
export const personalDefaultsInputSchema = z.object({
  defaultModelSlug: z.string().min(1).max(120).nullable().optional(),
  defaultEffort: z.enum(REASONING_EFFORTS).nullable().optional(),
});

/** Which saved defaults no longer apply, so Settings can say why. */
export const PERSONAL_DEFAULT_PROBLEMS = ['model', 'effort'] as const;
export type PersonalDefaultProblem = (typeof PERSONAL_DEFAULT_PROBLEMS)[number];

/**
 * Body of `POST /api/me/delete-account` (v0.10). `confirmEmail` must be the
 * account's email; `password` is required when the account has one.
 */
export const deleteOwnAccountSchema = z
  .object({
    confirmEmail: z.string().min(1).max(320),
    password: z.string().min(1).max(200).optional(),
  })
  .strict();

export type DeleteOwnAccountInput = z.infer<typeof deleteOwnAccountSchema>;
