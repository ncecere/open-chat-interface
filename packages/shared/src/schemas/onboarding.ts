import { z } from 'zod';

/** A published policy version, as an administrator manages it. */
export const usagePolicySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  publishedAt: z.string().nullable(),
  acceptanceCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export const upsertUsagePolicySchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1).max(50_000),
    /**
     * Publishing is explicit and one-way for a version. A published policy is
     * never edited in place, because an acceptance records agreement to
     * specific words.
     */
    publish: z.boolean().default(false),
  })
  .strict();

/** What a user is asked to accept. */
export const pendingPolicySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  /** True when they accepted an earlier version and this one supersedes it. */
  isUpdate: z.boolean(),
});

/**
 * What the application needs before letting someone in: an unaccepted policy
 * blocks, an unfinished introduction merely prompts.
 */
export const onboardingStateSchema = z.object({
  pendingPolicy: pendingPolicySchema.nullable(),
  needsIntroduction: z.boolean(),
});

export const completeOnboardingSchema = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    occupation: z.string().trim().max(200).nullable().optional(),
    traits: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    additionalContext: z.string().trim().max(4_000).nullable().optional(),
  })
  .strict();

export type UsagePolicy = z.infer<typeof usagePolicySchema>;
export type UpsertUsagePolicyInput = z.infer<typeof upsertUsagePolicySchema>;
export type PendingPolicy = z.infer<typeof pendingPolicySchema>;
export type OnboardingState = z.infer<typeof onboardingStateSchema>;
export type CompleteOnboardingInput = z.infer<typeof completeOnboardingSchema>;
