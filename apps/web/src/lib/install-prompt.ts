import { useSyncExternalStore } from 'react';

/**
 * Installing the app from Settings → Customization (#400).
 *
 * Chromium browsers fire `beforeinstallprompt` once, when the app becomes
 * installable, often long before anyone opens Settings; the event is kept
 * here from the first load so the control can use it later. Safari and
 * Firefox never fire it, so there the control does not appear and the docs
 * say how to install (Add to Home Screen).
 */

/** The (non-standard) event Chromium fires; not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let offered: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function set(next: BeforeInstallPromptEvent | null) {
  offered = next;
  for (const listener of listeners) listener();
}

/**
 * Starts keeping the install offer. Called once at startup (main.tsx); the
 * returned function stops it, for tests.
 */
export function listenForInstallPrompt(target: Window = window): () => void {
  const onOffer = (event: Event) => {
    // Hold the browser's own banner back: the offer is made from Settings.
    event.preventDefault();
    set(event as BeforeInstallPromptEvent);
  };
  // Installed from the browser's own menu, or from this control.
  const onInstalled = () => set(null);
  target.addEventListener('beforeinstallprompt', onOffer);
  target.addEventListener('appinstalled', onInstalled);
  return () => {
    target.removeEventListener('beforeinstallprompt', onOffer);
    target.removeEventListener('appinstalled', onInstalled);
    set(null);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the browser has offered installing, and a way to ask it to. */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<void> } {
  const event = useSyncExternalStore(
    subscribe,
    () => offered,
    () => null,
  );
  return {
    canInstall: event !== null,
    async install() {
      if (!event) return;
      // An offer can be used once, whatever the person answers; the browser
      // fires a new one if it decides to offer again.
      set(null);
      await event.prompt();
      await event.userChoice;
    },
  };
}
