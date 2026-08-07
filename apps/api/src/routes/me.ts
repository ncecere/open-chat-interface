import { eq, schema } from '@oci/db';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';

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
  const preferences = await loadPreferences(user.id);

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
  });
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
