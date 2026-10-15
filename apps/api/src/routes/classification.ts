import type { DataClassList } from '@oci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { validationFailed } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { classificationMode } from '../services/classification/config.js';
import { describeClassification } from '../services/classification/describe.js';
import { listClasses, toDataClass } from '../services/classification/store.js';

/**
 * What a person needs to label and to choose a model (v0.14, #395). Every
 * answer is about the caller's own conversation or project; anyone else's is
 * a 404. The server computes which models are approved so no client does set
 * arithmetic.
 */
export const classificationRoutes = new Hono<AppBindings>();

const querySchema = z.object({
  threadId: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(200).optional(),
});

classificationRoutes.get('/classification', requireAuth, async (c) => {
  const user = currentUser(c);
  const query = querySchema.parse(c.req.query());
  if (Boolean(query.threadId) === Boolean(query.projectId))
    throw validationFailed('Give either threadId or projectId.');
  return c.json(
    await describeClassification({
      userId: user.id,
      role: user.role,
      threadId: query.threadId,
      projectId: query.projectId,
    }),
  );
});

/** The classes that can still be added as a label. Empty while classification is off. */
classificationRoutes.get('/data-classes', requireAuth, async (c) => {
  const body: DataClassList = {
    classes:
      (await classificationMode()) === 'off'
        ? []
        : (await listClasses({ includeRetired: false })).map(toDataClass),
  };
  return c.json(body);
});
