/**
 * What Enter does in a message field (v0.9.1).
 *
 * - Normally Enter sends and Shift+Enter starts a new line.
 * - With "Invert Send/New Line Behavior" on, Enter (and Shift+Enter) start a
 *   new line and Cmd/Ctrl+Enter sends.
 * - The message editor (a larger multi-line box) always behaves as inverted,
 *   as it always has, so the two agree when the setting is on.
 *
 * Enter that confirms an input-method (IME) candidate never sends. Safari can
 * report composition ended while keeping the composing keyCode (229).
 */
export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
}

export function isSendKey(event: SendKeyEvent, options: { invert: boolean }): boolean {
  if (event.key !== 'Enter') return false;
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
  const modifier = event.metaKey || event.ctrlKey;
  if (options.invert) return modifier;
  return !event.shiftKey;
}

/** The send shortcut for `aria-keyshortcuts` on a Send button. */
export function sendKeyShortcuts(invert: boolean): string {
  return invert ? 'Meta+Enter Control+Enter' : 'Enter';
}
