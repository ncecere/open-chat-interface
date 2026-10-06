import { and, desc, eq, schema } from '@oci/db';
import { asksForArtifact } from '@oci/shared';
import { db } from '../../db/index.js';
import { replyText } from './detection.js';

/**
 * The floor under Markdown artifacts (#149) itself is in @oci/shared
 * (`markdownArtifactRefusal`), where the conversation also reads it (#201).
 */

/**
 * Whether the person's latest message in the conversation asks for an
 * artifact by name: then the floor gives way, as the guidance's "unless the
 * person asks for an artifact" does.
 */
export async function personAskedForArtifact(threadId: string): Promise<boolean> {
  const [latest] = await db
    .select({ parts: schema.message.parts })
    .from(schema.message)
    .where(and(eq(schema.message.threadId, threadId), eq(schema.message.role, 'user')))
    .orderBy(desc(schema.message.position))
    .limit(1);
  return latest ? asksForArtifact(replyText(latest.parts)) : false;
}
