import { eq, schema } from '@oci/db';
import type { UserRole } from '@oci/shared';
import { db } from '../db/index.js';
import { artifactGuidance } from './artifacts/guidance.js';
import { getDisplayTimezone } from './lifecycle/settings.js';
import { getSetting } from './settings.js';

/**
 * Composes the system prompt from the instance default plus the user's
 * customization settings, then today's date: where the person is, when their
 * browser said (`personTimeZone`), else where the instance is. With a
 * conversation `context`, it ends with the artifacts guidance when the
 * person's role allows artifacts.
 */
export async function buildSystemPrompt(
  userId: string,
  userName: string,
  context?: { role: UserRole; threadId: string; artifactTools: boolean },
  personTimeZone?: string | null,
): Promise<string> {
  const personal = knownTimeZone(personTimeZone);
  const [prompt, timeZone] = await Promise.all([
    basePrompt(userId, userName),
    personal ?? getDisplayTimezone(),
  ]);
  const base = `${prompt}\n\n${currentDateLine(new Date(), timeZone, Boolean(personal))}`;
  if (!context) return base;
  const artifacts = await artifactGuidance({
    role: context.role,
    userId,
    threadId: context.threadId,
    tools: context.artifactTools,
  });
  return artifacts ? `${base}\n\n${artifacts}` : base;
}

/**
 * A time zone as the server's zone data names it, or null for one it does not
 * know (or none). Only this canonical name reaches the prompt, never the text
 * a client sent.
 */
export function knownTimeZone(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Today's date, so the model can place "latest", "this week" or a deadline,
 * and search results, in time instead of assuming its training cutoff (#204).
 * The day is the person's, in the time zone their browser sends with each
 * message (#248): with the instance's zone alone, an evening in the Americas
 * was already tomorrow on a UTC instance. Without one (an older client), the
 * instance's display time zone (Branding) stands in. The zone is named so the
 * model can allow for it. Only the date, not the time: the prompt stays the
 * same all day.
 */
export function currentDateLine(now: Date, timeZone: string, personal = false): string {
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
  return personal
    ? `Today's date is ${date} where the user is (time zone ${timeZone}).`
    : `Today's date is ${date} (time zone ${timeZone}).`;
}

async function basePrompt(userId: string, userName: string): Promise<string> {
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
