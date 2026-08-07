import { eq, schema } from '@oci/db';
import { db } from '../db/index.js';
import { getSetting } from './settings.js';

/**
 * Composes the system prompt from the instance default plus the user's
 * customization settings.
 */
export async function buildSystemPrompt(userId: string, userName: string): Promise<string> {
  const [chat, preference] = await Promise.all([
    getSetting('chat'),
    db
      .select()
      .from(schema.userPreference)
      .where(eq(schema.userPreference.userId, userId))
      .limit(1)
      .then((rows) => rows[0]),
  ]);

  const sections: string[] = [];

  if (chat.defaultSystemPrompt?.trim()) {
    sections.push(chat.defaultSystemPrompt.trim());
  }

  const displayName = preference?.displayName?.trim() || userName;
  if (displayName) sections.push(`The user's name is ${displayName}.`);

  if (preference?.occupation?.trim()) {
    sections.push(`They work as: ${preference.occupation.trim()}.`);
  }

  if (preference?.traits?.length) {
    sections.push(`Preferred assistant traits: ${preference.traits.join(', ')}.`);
  }

  if (preference?.additionalContext?.trim()) {
    sections.push(preference.additionalContext.trim());
  }

  if (sections.length === 0) {
    return 'You are a helpful assistant.';
  }

  return sections.join('\n\n');
}
