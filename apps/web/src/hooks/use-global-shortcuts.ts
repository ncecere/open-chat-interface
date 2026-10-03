import { useEffect, useRef } from 'react';
import { matchShortcut, OPEN_MODEL_PICKER_EVENT } from '~/lib/keyboard-shortcuts';

export interface GlobalShortcutHandlers {
  onNewChat: () => void;
  onToggleSidebar: () => void;
}

/**
 * Installs ⌘⇧O (new chat), ⌘B (toggle the sidebar) and ⌘/ (open the
 * composer's model picker), Ctrl on other platforms.
 *
 * Listens on `window`, so the shortcuts work wherever focus is, including the
 * composer. ⌘/ asks the composer's picker to open; on a page without one
 * nothing claims it and the key press is left alone.
 */
export function useGlobalShortcuts(handlers: GlobalShortcutHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const shortcut = matchShortcut(event);
      if (!shortcut) return;

      if (shortcut === 'model-picker') {
        const request = new Event(OPEN_MODEL_PICKER_EVENT, { cancelable: true });
        // A picker that opened cancels the request.
        if (!window.dispatchEvent(request)) event.preventDefault();
        return;
      }

      event.preventDefault();
      if (shortcut === 'new-chat') latest.current.onNewChat();
      else latest.current.onToggleSidebar();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
