import { z } from 'zod';
import { USER_ROLES } from '../constants.js';

export const BROADCAST_LEVELS = ['info', 'warning', 'critical'] as const;
export type BroadcastLevel = (typeof BROADCAST_LEVELS)[number];

/** An announcement as an administrator manages it. */
export const broadcastSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  level: z.enum(BROADCAST_LEVELS),
  /** Empty means everyone. */
  audienceRoles: z.array(z.enum(USER_ROLES)),
  dismissable: z.boolean(),
  published: z.boolean(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  /** Derived: whether it is on screen for its audience right now. */
  active: z.boolean(),
  dismissalCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export const upsertBroadcastSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(2_000),
    level: z.enum(BROADCAST_LEVELS).default('info'),
    audienceRoles: z.array(z.enum(USER_ROLES)).max(USER_ROLES.length).default([]),
    dismissable: z.boolean().default(true),
    published: z.boolean().default(false),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'The end time must be after the start time.',
      });
    }
  });

/** What a user receives: only what is needed to render and dismiss it. */
export const activeBroadcastSchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  level: z.enum(BROADCAST_LEVELS),
  dismissable: z.boolean(),
  /**
   * When it stops being shown (ISO), so a page left open hides it then rather
   * than at its next refresh: a scheduled window's announcement ends as the
   * window starts (#160). Absent from servers before v0.11.1.
   */
  endsAt: z.string().nullable().optional(),
});

export type Broadcast = z.infer<typeof broadcastSchema>;
export type UpsertBroadcastInput = z.infer<typeof upsertBroadcastSchema>;
export type ActiveBroadcast = z.infer<typeof activeBroadcastSchema>;
