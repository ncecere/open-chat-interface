import { createPersonaSchema, updatePersonaSchema } from '@oci/shared';
import { Hono } from 'hono';
import { type AppBindings, currentUser, requireAuth } from '../middleware/context.js';
import { parseBody } from '../middleware/validate.js';
import {
  assertPersonasAllowed,
  createPersona,
  deletePersona,
  listPersonas,
  updatePersona,
} from '../services/personas.js';

export const personaRoutes = new Hono<AppBindings>();

personaRoutes.use('*', requireAuth);

function serializePersona(persona: Awaited<ReturnType<typeof createPersona>>) {
  return {
    id: persona.id,
    name: persona.name,
    icon: persona.icon,
    systemPrompt: persona.systemPrompt,
    traits: persona.traits,
    isDefault: persona.isDefault,
    createdAt: persona.createdAt.toISOString(),
    updatedAt: persona.updatedAt.toISOString(),
  };
}

personaRoutes.get('/', async (c) => {
  const user = currentUser(c);
  await assertPersonasAllowed(user.role);
  const personas = await listPersonas(user.id, user.organizationId);
  return c.json({ personas: personas.map(serializePersona) });
});

personaRoutes.post('/', async (c) => {
  const user = currentUser(c);
  await assertPersonasAllowed(user.role);
  const input = await parseBody(c, createPersonaSchema);
  const persona = await createPersona(user.id, user.organizationId, input);
  return c.json({ persona: serializePersona(persona) }, 201);
});

personaRoutes.patch('/:id', async (c) => {
  const user = currentUser(c);
  await assertPersonasAllowed(user.role);
  const input = await parseBody(c, updatePersonaSchema);
  const persona = await updatePersona(c.req.param('id'), user.id, user.organizationId, input);
  return c.json({ persona: serializePersona(persona) });
});

personaRoutes.delete('/:id', async (c) => {
  const user = currentUser(c);
  await assertPersonasAllowed(user.role);
  await deletePersona(c.req.param('id'), user.id, user.organizationId);
  return c.json({ ok: true });
});
