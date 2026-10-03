import {
  createMemorySchema,
  undoMemorySchema,
  updateMemorySchema,
  updateMemorySettingsSchema,
} from '@oci/shared';
import { Hono } from 'hono';
import { notFound } from '../lib/errors.js';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import {
  addMemory,
  assertMemoryAvailable,
  deleteAllMemories,
  deleteMemory,
  memoryState,
  setMemoryEnabled,
  toMemoryEntry,
  undoMemoryChange,
  updateMemory,
} from '../services/memory/store.js';

/**
 * Settings -> Memory (v0.9). Everything is scoped to the signed-in person:
 * another person's memory is reported as not found. Reading and deleting
 * always work, so a person can see and remove what is stored about them even
 * after memory was switched off; adding and editing need the instance and the
 * role to allow memory.
 */
export const memoryRoutes = new Hono<AppBindings>();

memoryRoutes.use('*', requireAuth);

/** The person's switch, whether memory is offered to them, their notes newest first, and the limits. */
memoryRoutes.get('/', async (c) => {
  const user = currentUser(c);
  return c.json(await memoryState(user));
});

/** Switches the person's own memory on or off; on needs the instance and role to allow it. */
memoryRoutes.put('/settings', async (c) => {
  const user = currentUser(c);
  const { enabled } = await parseBody(c, updateMemorySettingsSchema);
  await setMemoryEnabled(user, enabled);
  return c.json(await memoryState(user));
});

/** Adds a note; an existing identical note is returned with `created: false`. */
memoryRoutes.post('/', async (c) => {
  const user = currentUser(c);
  const { content } = await parseBody(c, createMemorySchema);
  await assertMemoryAvailable(user.role);
  const { row, created } = await addMemory(user.id, content, {
    source: 'person',
    via: 'settings',
  });
  return c.json({ memory: toMemoryEntry(row), created }, created ? 201 : 200);
});

/** Reverses one `remember` or `forget` step of the person's own reply. */
memoryRoutes.post('/undo', async (c) => {
  const user = currentUser(c);
  const input = await parseBody(c, undoMemorySchema);
  return c.json(await undoMemoryChange(user, input));
});

/** Changes the text of one of the person's notes. */
memoryRoutes.patch('/:id', async (c) => {
  const user = currentUser(c);
  const { content } = await parseBody(c, updateMemorySchema);
  await assertMemoryAvailable(user.role);
  const row = await updateMemory(user.id, c.req.param('id'), content);
  return c.json({ memory: toMemoryEntry(row) });
});

/** Deletes one of the person's notes. */
memoryRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  const removed = await deleteMemory(user.id, c.req.param('id'), 'settings');
  if (!removed) throw notFound('Memory not found');
  return c.json({ ok: true });
});

/** Deletes every note the person has. */
memoryRoutes.delete('/', async (c) => {
  const user = currentUser(c);
  return c.json({ deleted: await deleteAllMemories(user.id) });
});
