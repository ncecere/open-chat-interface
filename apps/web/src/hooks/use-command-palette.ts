import { useCallback, useEffect, useState } from 'react';

/** Owns the global palette state and installs its platform keyboard shortcut. */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.repeat || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) return;

      event.preventDefault();
      setOpen((current) => !current);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const show = useCallback(() => setOpen(true), []);

  return { open, setOpen, show };
}
