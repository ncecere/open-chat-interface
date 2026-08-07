import { and, asc, eq, ne, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { forbidden, notFound, validationFailed } from '../lib/errors.js';
import { getSetting } from './settings.js';

export interface PersonaPatch {
  name?: string;
  icon?: string | null;
  systemPrompt?: string;
  traits?: string[];
  isDefault?: boolean;
}

export async function assertPersonasAllowed(role: UserRole): Promise<void> {
  if (role === 'restricted') {
    throw forbidden('Your role does not allow personas');
  }

  const features = await getSetting('features');
  if (!features.personas) {
    throw validationFailed('Personas are disabled on this instance');
  }
}

function cleanPatch<T extends PersonaPatch>(input: T): T {
  return {
    ...input,
    ...(input.icon !== undefined ? { icon: input.icon?.trim() || null } : {}),
    ...(input.traits !== undefined
      ? { traits: [...new Set(input.traits.map((trait) => trait.trim()))] }
      : {}),
  };
}

export async function listPersonas(userId: string, organizationId: string) {
  return db
    .select()
    .from(schema.persona)
    .where(
      and(eq(schema.persona.userId, userId), eq(schema.persona.organizationId, organizationId)),
    )
    .orderBy(asc(schema.persona.createdAt));
}

export async function getOwnedPersona(personaId: string, userId: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.persona)
    .where(
      and(
        eq(schema.persona.id, personaId),
        eq(schema.persona.userId, userId),
        eq(schema.persona.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Persona not found');
  return row;
}

export async function getDefaultPersona(userId: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.persona)
    .where(
      and(
        eq(schema.persona.userId, userId),
        eq(schema.persona.organizationId, organizationId),
        eq(schema.persona.isDefault, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function createPersona(
  userId: string,
  organizationId: string,
  input: Required<Pick<PersonaPatch, 'name' | 'systemPrompt' | 'traits'>> & PersonaPatch,
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.persona.id })
      .from(schema.persona)
      .where(
        and(eq(schema.persona.userId, userId), eq(schema.persona.organizationId, organizationId)),
      )
      .limit(1);

    const patch = cleanPatch(input);
    const isDefault = input.isDefault === true || !existing;

    if (isDefault) {
      await tx
        .update(schema.persona)
        .set({ isDefault: false })
        .where(
          and(eq(schema.persona.userId, userId), eq(schema.persona.organizationId, organizationId)),
        );
    }

    const [created] = await tx
      .insert(schema.persona)
      .values({ ...patch, userId, organizationId, isDefault })
      .returning();

    if (!created) throw new Error('Failed to create persona');
    return created;
  });
}

export async function updatePersona(
  personaId: string,
  userId: string,
  organizationId: string,
  input: PersonaPatch,
) {
  await getOwnedPersona(personaId, userId, organizationId);
  const patch = cleanPatch(input);

  return db.transaction(async (tx) => {
    if (patch.isDefault) {
      await tx
        .update(schema.persona)
        .set({ isDefault: false })
        .where(
          and(
            eq(schema.persona.userId, userId),
            eq(schema.persona.organizationId, organizationId),
            ne(schema.persona.id, personaId),
          ),
        );
    }

    const [updated] = await tx
      .update(schema.persona)
      .set(patch)
      .where(
        and(
          eq(schema.persona.id, personaId),
          eq(schema.persona.userId, userId),
          eq(schema.persona.organizationId, organizationId),
        ),
      )
      .returning();

    if (!updated) throw notFound('Persona not found');
    return updated;
  });
}

export async function deletePersona(
  personaId: string,
  userId: string,
  organizationId: string,
): Promise<void> {
  const owned = await getOwnedPersona(personaId, userId, organizationId);

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.persona)
      .where(
        and(
          eq(schema.persona.id, personaId),
          eq(schema.persona.userId, userId),
          eq(schema.persona.organizationId, organizationId),
        ),
      );

    if (!owned.isDefault) return;

    const [replacement] = await tx
      .select({ id: schema.persona.id })
      .from(schema.persona)
      .where(
        and(eq(schema.persona.userId, userId), eq(schema.persona.organizationId, organizationId)),
      )
      .orderBy(asc(schema.persona.createdAt))
      .limit(1);

    if (replacement) {
      await tx
        .update(schema.persona)
        .set({ isDefault: true })
        .where(eq(schema.persona.id, replacement.id));
    }
  });
}
