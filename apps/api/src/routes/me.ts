import { and, count, eq, isNull, schema } from '@oci/db';
import {
  completeOnboardingSchema,
  deleteOwnAccountSchema,
  myShareLinksQuerySchema,
  personalDefaultsInputSchema,
  type ReasoningEffort,
} from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { auth } from '../auth/index.js';
import { signInMethodsFor } from '../auth/policy.js';
import { db } from '../db/index.js';
import { clientIp } from '../lib/client-ip.js';
import { logger } from '../lib/logger.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import { deleteOwnAccount } from '../services/account-deletion.js';
import {
  listOwnSessions,
  revokeOtherOwnSessions,
  revokeOwnSession,
} from '../services/account-sessions.js';
import { recordAudit } from '../services/audit.js';
import { activeBroadcastsFor, dismissBroadcast } from '../services/broadcasts.js';
import { userConnectors } from '../services/connectors/people.js';
import { listAvailableModels } from '../services/models.js';
import {
  acceptPolicy,
  completeIntroduction,
  onboardingStateFor,
  skipIntroduction,
} from '../services/onboarding.js';
import {
  assertPersonalDefaultsAllowed,
  resolvePersonalDefaults,
} from '../services/personal-defaults.js';
import { getUsageSummary } from '../services/quota/index.js';
import { combineFeatures, roleFeatures } from '../services/role-features.js';
import { getSetting } from '../services/settings.js';
import { listOwnShareLinks, revokeAllOwnShareLinks } from '../services/share-links.js';

export const meRoutes = new Hono<AppBindings>();

meRoutes.use('*', requireAuth);

const preferenceSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    mainFont: z.string().max(60).optional(),
    codeFont: z.string().max(60).optional(),
    density: z.enum(['comfortable', 'compact']).optional(),
    displayName: z.string().max(120).nullable().optional(),
    occupation: z.string().max(200).nullable().optional(),
    traits: z.array(z.string().max(60)).max(20).optional(),
    additionalContext: z.string().max(4000).nullable().optional(),
  })
  .extend(personalDefaultsInputSchema.shape);

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

/** Share links the person has not revoked, for hiding an empty Sharing tab (v0.10). */
async function activeShareLinkCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(schema.shareLink)
    .where(and(eq(schema.shareLink.userId, userId), isNull(schema.shareLink.revokedAt)));
  return Number(row?.value ?? 0);
}

meRoutes.get('/', async (c) => {
  const user = currentUser(c);
  const [
    preferences,
    features,
    search,
    chat,
    storage,
    own,
    signIn,
    memoryEntries,
    connectors,
    shareLinks,
  ] = await Promise.all([
    loadPreferences(user.id),
    getSetting('features'),
    getSetting('search'),
    getSetting('chat'),
    getSetting('storage'),
    roleFeatures(user.role),
    signInMethodsFor(user),
    memoryEntryCount(user.id),
    userConnectors(user),
    activeShareLinkCount(user.id),
  ]);
  const { reasoningEfforts, ...effective } = combineFeatures(features, search, own);
  const instanceEffort: ReasoningEffort = chat.defaultEffort ?? 'instant';
  // The catalog is read only when a model is saved, so most requests skip it.
  const saved = {
    defaultModelSlug: preferences?.defaultModelSlug ?? null,
    defaultEffort: preferences?.defaultEffort ?? null,
  };
  const personal = resolvePersonalDefaults(saved, {
    catalog: saved.defaultModelSlug ? await listAvailableModels(user.role) : null,
    roleEfforts: reasoningEfforts,
    instanceEffort,
  });

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
     * without fetching each section on every settings page. `shareLinks`
     * (v0.10) counts links not yet revoked.
     */
    settingsSummary: { memoryEntries, connectors: connectors.length, shareLinks },
    // Instance switches narrowed by the role's own. Web search is advertised
    // only when a search would actually run.
    features: { ...features, ...effective },
    chat: {
      /**
       * Where the composer starts, before clamping to the model's levels: the
       * person's own level when it still applies (v0.10), otherwise the
       * instance's.
       */
      defaultEffort: personal.effort,
      /** The administrator's level, shown in Settings → Models (v0.10). */
      instanceDefaultEffort: instanceEffort,
      /**
       * The person's own model when it is still available to them (v0.10);
       * null means the catalog's default.
       */
      defaultModelSlug: personal.modelSlug,
      /** Saved defaults that no longer apply and are ignored (v0.10). */
      defaultProblems: personal.problems,
      reasoningEfforts,
      /**
       * Attachment limits the composer checks before uploading (v0.11.1), so a
       * file over them is refused at once instead of uploading, counting
       * against storage, and failing only when the message is sent.
       */
      maxFilesPerMessage: storage.maxFilesPerMessage,
      maxFileBytes: storage.maxFileBytes,
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

/**
 * Saves the person's preferences. A default model or reasoning level must be
 * one their role allows (422 otherwise); null returns to the instance default.
 */
meRoutes.patch('/preferences', async (c) => {
  const user = currentUser(c);
  const patch = await parseBody(c, preferenceSchema);

  const current = await loadPreferences(user.id);
  if (patch.defaultModelSlug !== undefined || patch.defaultEffort !== undefined) {
    const [catalog, own] = await Promise.all([
      listAvailableModels(user.role),
      roleFeatures(user.role),
    ]);
    assertPersonalDefaultsAllowed(
      { defaultModelSlug: patch.defaultModelSlug, defaultEffort: patch.defaultEffort },
      {
        defaultModelSlug:
          patch.defaultModelSlug !== undefined
            ? patch.defaultModelSlug
            : (current?.defaultModelSlug ?? null),
        defaultEffort:
          patch.defaultEffort !== undefined
            ? patch.defaultEffort
            : (current?.defaultEffort ?? null),
      },
      { catalog, roleEfforts: own.reasoningEfforts },
    );
  }

  const [updated] = await db
    .update(schema.userPreference)
    .set(patch)
    .where(eq(schema.userPreference.userId, user.id))
    .returning();

  return c.json({ preferences: updated });
});

/**
 * Settings → Sharing (v0.10): every share link this person made, newest first,
 * 50 per page (`limit` up to 100, `offset`). Listed even while sharing is off
 * for their role or the instance, so they can still revoke them.
 */
meRoutes.get('/share-links', async (c) => {
  const user = currentUser(c);
  const page = parseQuery(c, myShareLinksQuerySchema);
  c.header('cache-control', 'no-store');
  return c.json(await listOwnShareLinks(user.id, page));
});

/**
 * Revokes every share link this person still has, audited as one
 * `share_link.revoke_all` entry with the count. Allowed while sharing is off.
 */
meRoutes.post('/share-links/revoke-all', async (c) => {
  const user = currentUser(c);
  const revoked = await revokeAllOwnShareLinks(user.id);
  if (revoked > 0) {
    await recordAudit({
      actorUserId: user.id,
      actorEmail: user.email,
      action: 'share_link.revoke_all',
      targetType: 'user',
      targetId: user.id,
      ipAddress: clientIp(c),
      metadata: { count: revoked },
    });
  }
  return c.json({ revoked });
});

/**
 * Deletes the signed-in person's own account and everything it owns (v0.10),
 * when their role allows it (403 otherwise). Needs their email typed and, for
 * an account with a password, the password (422). Refused on legal hold and
 * for the last administrator (409). Audited as `user.delete` with `self: true`.
 */
meRoutes.post('/delete-account', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, deleteOwnAccountSchema);
  const result = await deleteOwnAccount(user, input, {
    ipAddress: clientIp(c),
    sessionId: c.get('sessionId') ?? null,
  });
  // The session went with the account, but this browser's signed session
  // cache would be accepted for up to five more minutes: expire its cookies now.
  try {
    const signedOut = await auth.api.signOut({ headers: c.req.raw.headers, returnHeaders: true });
    for (const cookie of signedOut.headers.getSetCookie()) {
      c.header('set-cookie', cookie, { append: true });
    }
  } catch (error) {
    logger.warn({ error }, 'Could not clear session cookies after account deletion');
  }
  return c.json(result);
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
