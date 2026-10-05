/**
 * The trait suggestions, one list for the introduction and Settings →
 * Customization (#96): they offered different sets. Traits describe how
 * replies are written.
 */
export const SUGGESTED_TRAITS = [
  'concise',
  'thorough',
  'formal',
  'casual',
  'encouraging',
  'direct',
  'patient',
  'technical',
] as const;

/** Pairs that contradict each other: choosing one drops the other. */
const OPPOSITES: Record<string, string> = {
  concise: 'thorough',
  thorough: 'concise',
  formal: 'casual',
  casual: 'formal',
};

export const MAX_TRAITS = 20;

/**
 * `traits` with `trait` added, and its opposite (if chosen) removed, so
 * "Concise" and "Thorough" are never both asked for. Unchanged if it is
 * already there, blank, or the list is full.
 */
export function withTrait(traits: readonly string[], trait: string): string[] {
  const value = trait.trim();
  const key = value.toLowerCase();
  if (!value || traits.some((entry) => entry.toLowerCase() === key)) return [...traits];
  const opposite = OPPOSITES[key];
  const kept = opposite ? traits.filter((entry) => entry.toLowerCase() !== opposite) : [...traits];
  if (kept.length >= MAX_TRAITS) return [...traits];
  return [...kept, value];
}
