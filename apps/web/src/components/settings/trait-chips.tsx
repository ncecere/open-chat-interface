import { Plus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { MAX_TRAITS, SUGGESTED_TRAITS, withTrait } from '~/lib/traits';

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });

/**
 * What a change to the traits did, for the status line: "Added thorough.
 * Removed concise." (choosing one drops its opposite, #96), or why nothing
 * changed.
 */
export function traitChange(before: readonly string[], after: readonly string[]): string {
  const added = after.filter((trait) => !before.includes(trait));
  const removed = before.filter((trait) => !after.includes(trait));
  if (!added.length && !removed.length)
    return before.length >= MAX_TRAITS ? `You can choose up to ${MAX_TRAITS} traits.` : '';
  return [
    added.length ? `Added ${listFormat.format(added)}.` : '',
    removed.length ? `Removed ${listFormat.format(removed)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

type ListName = 'chosen' | 'suggested';

/**
 * The chosen traits and the suggestions, under Settings › Customization's
 * trait field. Both were plain buttons named only by the trait ("direct",
 * "concise"), so a screen reader could not tell a chosen trait from a
 * suggestion, nor that pressing a chosen one removes it (#299). Each list is
 * named, and each button says what pressing it does: "Remove trait: direct",
 * "Add trait: concise"; the trait stays at the start of the visible text.
 *
 * A pressed button leaves its list (a chosen trait goes, a suggestion moves
 * up to the chosen ones), so focus moves to the button that takes its place,
 * or the one before, or else the trait field, instead of falling to the page.
 */
export function TraitChips({
  traits,
  onChange,
  inputId,
}: {
  traits: string[];
  onChange: (next: string[]) => void;
  /** The trait field, focused when a list empties. */
  inputId: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const refocus = useRef<{ list: ListName; index: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the pressed button's list has changed.
  useEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    const buttons = [
      ...(rootRef.current?.querySelectorAll<HTMLButtonElement>(
        `[data-trait-list="${target.list}"] button`,
      ) ?? []),
    ];
    (
      buttons[target.index] ??
      buttons[target.index - 1] ??
      document.getElementById(inputId)
    )?.focus();
  }, [traits]);

  const press = (list: ListName, index: number, next: string[]) => {
    refocus.current = { list, index };
    onChange(next);
  };
  const suggestions = SUGGESTED_TRAITS.filter((trait) => !traits.includes(trait));

  return (
    <div ref={rootRef}>
      {traits.length > 0 && (
        <ul
          aria-label="Chosen traits"
          data-trait-list="chosen"
          className="mt-3 flex flex-wrap gap-2"
        >
          {traits.map((trait, index) => (
            <li key={trait}>
              <button
                type="button"
                aria-label={`Remove trait: ${trait}`}
                onClick={() =>
                  press(
                    'chosen',
                    index,
                    traits.filter((entry) => entry !== trait),
                  )
                }
                className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-foreground)]"
              >
                {trait}
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {suggestions.length > 0 && (
        <ul
          aria-label="Suggested traits"
          data-trait-list="suggested"
          className="mt-3 flex flex-wrap gap-2"
        >
          {suggestions.map((trait, index) => (
            <li key={trait}>
              <button
                type="button"
                aria-label={`Add trait: ${trait}`}
                onClick={() => press('suggested', index, withTrait(traits, trait))}
                className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-control-alt)] px-2.5 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                {trait}
                <Plus className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
