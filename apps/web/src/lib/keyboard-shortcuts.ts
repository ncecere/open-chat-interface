/**
 * The app-wide keyboard shortcuts, in one place so the handler, the
 * `aria-keyshortcuts` on each control, the Settings card and the command
 * palette cannot disagree.
 *
 * The modifier is ⌘ on Apple platforms and Ctrl everywhere else. Search (⌘K)
 * predates this list and also answers to the other modifier; see
 * `use-command-palette.ts`.
 */
export type ShortcutId = 'search' | 'new-chat' | 'toggle-sidebar' | 'model-picker';

interface ShortcutDefinition {
  label: string;
  /** `KeyboardEvent.key`, lower case. */
  key: string;
  shift: boolean;
}

export const SHORTCUTS: Record<ShortcutId, ShortcutDefinition> = {
  search: { label: 'Search', key: 'k', shift: false },
  'new-chat': { label: 'New Chat', key: 'o', shift: true },
  'toggle-sidebar': { label: 'Toggle Sidebar', key: 'b', shift: false },
  'model-picker': { label: 'Open Model Picker', key: '/', shift: false },
};

/** In display order. */
export const SHORTCUT_IDS: ShortcutId[] = ['search', 'new-chat', 'toggle-sidebar', 'model-picker'];

/** Dispatched on `window`; the composer's model picker opens and calls `preventDefault()`. */
export const OPEN_MODEL_PICKER_EVENT = 'oci:open-model-picker';

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The keys as shown in a `<kbd>` row: ⌘ ⇧ O on a Mac, Ctrl Shift O elsewhere. */
export function shortcutKeys(id: ShortcutId, apple = isApplePlatform()): string[] {
  const { key, shift } = SHORTCUTS[id];
  const keys = [apple ? '⌘' : 'Ctrl'];
  if (shift) keys.push(apple ? '⇧' : 'Shift');
  keys.push(key.toUpperCase());
  return keys;
}

/** The modifier alone, for shortcuts listed elsewhere (⌘ Enter to send). */
export function modifierKey(apple = isApplePlatform()): string {
  return apple ? '⌘' : 'Ctrl';
}

/** The `aria-keyshortcuts` value, in the platform's own modifier. */
export function ariaKeyShortcuts(id: ShortcutId, apple = isApplePlatform()): string {
  const { key, shift } = SHORTCUTS[id];
  return [apple ? 'Meta' : 'Control', ...(shift ? ['Shift'] : []), key.toUpperCase()].join('+');
}

type ShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'keyCode'
>;

/**
 * Which of the global shortcuts (other than search) a key press is, if any.
 *
 * Nothing matches while an input method is composing: the key that ends a
 * composition belongs to the IME. Auto-repeat is ignored, so holding the keys
 * does not flicker the sidebar. Shift is not checked for ⌘/, because on many
 * layouts "/" itself needs Shift.
 */
export function matchShortcut(
  event: ShortcutEvent,
  apple = isApplePlatform(),
): Exclude<ShortcutId, 'search'> | null {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return null;
  const modifier = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;

  const key = event.key.toLowerCase();
  if (key === '/') return 'model-picker';
  if (key === 'o' && event.shiftKey) return 'new-chat';
  if (key === 'b' && !event.shiftKey) return 'toggle-sidebar';
  return null;
}
