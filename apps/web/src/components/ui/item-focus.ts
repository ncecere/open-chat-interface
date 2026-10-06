/**
 * How a list item shows that it has keyboard focus, shared by menus, Select
 * popups, the model picker and the command palette (#135).
 *
 * A background change alone is not enough: the menu surface and the control
 * grey are the same white in light (1:1) and 1.05:1 apart in dark, so a
 * focused item looked like every other. The ring uses --accent-bright, the
 * colour of every other focus ring, which clears 3:1 (WCAG 1.4.11) against
 * the menu surface and the highlighted wash in every theme and accent.
 *
 * The wash follows Radix's highlight, which the pointer moves too; the ring
 * is for keyboard focus only (:focus-visible), as on the rest of the page.
 */
export const MENU_ITEM_FOCUS = [
  'outline-none',
  'data-[highlighted]:bg-[var(--bg-control-hover)] data-[highlighted]:text-[var(--text-primary)]',
  'focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2',
  'focus-visible:outline-[var(--accent-bright)]',
].join(' ');

/**
 * The option a listbox's arrow keys are on while focus stays in its search box
 * (aria-activedescendant). Nothing is focused, so the ring is drawn always.
 */
export const ACTIVE_OPTION_RING =
  'outline outline-2 -outline-offset-2 outline-[var(--accent-bright)]';
