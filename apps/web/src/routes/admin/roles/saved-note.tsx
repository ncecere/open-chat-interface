import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';

export function SavedNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="flex items-center gap-1.5 text-[var(--success)] text-sm">
      <CheckCircle2 className="size-4" aria-hidden="true" />
      Saved
    </span>
  );
}

export function useSavedFlash() {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2_500);
    return () => clearTimeout(timer);
  }, [saved]);
  return [saved, setSaved] as const;
}
