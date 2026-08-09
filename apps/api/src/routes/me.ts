import { eq, schema } from '@oci/db';
import { completeOnboardingSchema } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { clientIp } from '../lib/client-ip.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import { activeBroadcastsFor, dismissBroadcast } from '../services/broadcasts.js';
import {
  acceptPolicy,
  completeIntroduction,
  onboardingStateFor,
  skipIntroduction,
} from '../services/onboarding.js';
import { getUsageSummary } from '../services/quota/index.js';
import { getSetting } from '../services/settings.js';

export const meRoutes = new Hono<AppBindings>();

meRoutes.use('*', requireAuth);

const preferenceSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  boringMode: z.boolean().optional(),
  mainFont: z.string().max(60).optional(),
  codeFont: z.string().max(60).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  displayName: z.string().max(120).nullable().optional(),
  occupation: z.string().max(200).nullable().optional(),
  traits: z.array(z.string().max(60)).max(20).optional(),
  additionalContext: z.string().max(4000).nullable().optional(),
  defaultModelSlug: z.string().max(120).nullable().optional(),
});

async function loadPreferences(userId: string) {
  const [existing] = await db
    .select()
    .from(schema.userPreference)
    .where(eq(schema.userPreference.userId, userId))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(schema.userPreference)
    .values({ userId })
    .onConflictDoNothing()
    .returning();

  return created ?? existing;
}

meRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const [preferences, features] = await Promise.all([
    loadPreferences(user.id),
    getSetting('features'),
  ]);

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role,
      emailVerified: user.emailVerified,
    },
    preferences,
    features: {
      ...features,
      attachments: features.attachments && user.role !== 'restricted',
      shareLinks: features.shareLinks && user.role !== 'restricted',
      temporaryChat: features.temporaryChat && user.role !== 'restricted',
    },
  });
});

meRoutes.get('/usage', async (c) => {
  const user = currentUser(c);
  const usage = await getUsageSummary(user.id, user.role);
  return c.json(usage);
});

meRoutes.patch('/preferences', async (c) => {
  const user = currentUser(c);
  const patch = await parseBody(c, preferenceSchema);

  await loadPreferences(user.id);

  const [updated] = await db
    .update(schema.userPreference)
    .set(patch)
    .where(eq(schema.userPreference.userId, user.id))
    .returning();

  return c.json({ preferences: updated });
});

/** Announcements this person should currently see. */
meRoutes.get('/broadcasts', async (c) => {
  const user = currentUser(c);
  return c.json({ broadcasts: await activeBroadcastsFor(user.id, user.role) });
});

meRoutes.post('/broadcasts/:id/dismiss', async (c) => {
  const user = currentUser(c);
  const dismissed = await dismissBroadcast(c.req.param('id'), user.id);
  return c.json({ ok: dismissed });
});

/** What must happen before this person can use the instance. */
meRoutes.get('/onboarding', async (c) => {
  const user = currentUser(c);
  return c.json(await onboardingStateFor(user.id));
});

meRoutes.post('/onboarding/accept-policy', async (c) => {
  const user = currentUser(c);
  const { policyId } = await parseBody(c, z.object({ policyId: z.string().min(1) }));

  await acceptPolicy({
    userId: user.id,
    policyId,
    // Recorded alongside the acceptance because it is part of the evidence.
    ipAddress: clientIp(c),
  });

  return c.json({ ok: true });
});

meRoutes.post('/onboarding/complete', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, completeOnboardingSchema);
  await completeIntroduction({ userId: user.id, ...input });
  return c.json({ ok: true });
});

meRoutes.post('/onboarding/skip', async (c) => {
  const user = currentUser(c);
  await skipIntroduction(user.id);
  return c.json({ ok: true });
});
