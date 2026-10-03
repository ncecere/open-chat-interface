import { count, eq, schema } from '@oci/db';
import { completeOnboardingSchema } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { signInMethodsFor } from '../auth/policy.js';
import { db } from '../db/index.js';
import { clientIp } from '../lib/client-ip.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import {
  listOwnSessions,
  revokeOtherOwnSessions,
  revokeOwnSession,
} from '../services/account-sessions.js';
import { recordAudit } from '../services/audit.js';
import { activeBroadcastsFor, dismissBroadcast } from '../services/broadcasts.js';
import { userConnectors } from '../services/connectors/people.js';
import {
  acceptPolicy,
  completeIntroduction,
  onboardingStateFor,
  skipIntroduction,
} from '../services/onboarding.js';
import { getUsageSummary } from '../services/quota/index.js';
import { combineFeatures, roleFeatures } from '../services/role-features.js';
import { getSetting } from '../services/settings.js';

export const meRoutes = new Hono<AppBindings>();

meRoutes.use('*', requireAuth);

const preferenceSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
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

/** How many memories the person has, for hiding an empty Memory tab. */
async function memoryEntryCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.userMemory)
    .where(eq(schema.userMemory.userId, userId));
  return Number(row?.value ?? 0);
}

meRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const [preferences, features, search, chat, own, signIn, memoryEntries, connectors] =
    await Promise.all([
      loadPreferences(user.id),
      getSetting('features'),
      getSetting('search'),
      getSetting('chat'),
      roleFeatures(user.role),
      signInMethodsFor(user),
      memoryEntryCount(user.id),
      userConnectors(user),
    ]);
  const { reasoningEfforts, ...effective } = combineFeatures(features, search, own);

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
    /** v0.9.1: which sign-in methods the person has, for Settings → Account. */
    signIn,
    /**
     * v0.9.1: what Settings needs to hide sections with nothing in them
     * without fetching each section on every settings page.
     */
    settingsSummary: { memoryEntries, connectors: connectors.length },
    // Instance switches narrowed by the role's own. Web search is advertised
    // only when a search would actually run.
    features: { ...features, ...effective },
    chat: {
      /** Where the composer starts, before clamping to the model's levels. */
      defaultEffort: chat.defaultEffort ?? 'instant',
      reasoningEfforts,
    },
  });
});

/** Settings → Account → Devices: where this person is signed in, this device first. */
meRoutes.get('/sessions', async (c) => {
  const user = currentUser(c);
  c.header('cache-control', 'no-store');
  return c.json({ sessions: await listOwnSessions(user.id, c.get('sessionId')) });
});

/** Signs out every other device. Audited with the number signed out. */
meRoutes.post('/sessions/revoke-others', async (c) => {
  const user = currentUser(c);
  const revoked = await revokeOtherOwnSessions(user.id, c.get('sessionId'));
  await recordAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'auth.sessions.revoked_others.success',
    targetType: 'session',
    targetId: null,
    ipAddress: clientIp(c),
    metadata: { count: revoked },
  });
  return c.json({ revoked });
});

/** Signs out one other device (404 for anyone else's or an unknown session). */
meRoutes.delete('/sessions/:id', async (c) => {
  const user = currentUser(c);
  const id = c.req.param('id');
  await revokeOwnSession(user.id, id, c.get('sessionId'));
  await recordAudit({
    actorUserId: user.id,
    actorEmail: user.email,
    action: 'auth.session.revoked.success',
    targetType: 'session',
    targetId: id,
    ipAddress: clientIp(c),
  });
  return c.json({ ok: true });
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
