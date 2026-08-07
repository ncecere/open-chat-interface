import { eq, schema } from '@oci/db';
import { db } from '../db/index.js';

const DEFAULT_SLUG = 'default';

let cachedId: string | null = null;

/**
 * Single-tenant helper. Every scoped query goes through this so multi-tenancy
 * becomes a matter of resolving a different organization per request.
 */
export async function getDefaultOrganizationId(): Promise<string> {
  if (cachedId) return cachedId;

  const [org] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, DEFAULT_SLUG))
    .limit(1);

  if (!org) {
    const [created] = await db
      .insert(schema.organization)
      .values({ slug: DEFAULT_SLUG, name: 'Open Chat Interface' })
      .returning({ id: schema.organization.id });

    if (!created) throw new Error('Unable to create default organization');
    cachedId = created.id;
    return cachedId;
  }

  cachedId = org.id;
  return cachedId;
}
