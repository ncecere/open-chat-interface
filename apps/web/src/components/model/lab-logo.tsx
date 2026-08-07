import { findModelLab, modelLabLogoUrl } from '@oci/shared';
import { Bot } from 'lucide-react';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

/**
 * Renders a model's lab mark for the active theme. Falls back to a generic
 * glyph so an unattributed or unknown lab never leaves a blank slot.
 */
export function LabLogo({
  labId,
  className,
  title,
}: {
  labId: string | null | undefined;
  className?: string;
  title?: string;
}) {
  const { resolvedTheme } = useTheme();
  const lab = findModelLab(labId);

  if (!lab) {
    return <Bot className={cn('size-4 text-[var(--text-muted)]', className)} aria-hidden="true" />;
  }

  return (
    <img
      src={modelLabLogoUrl(lab, resolvedTheme)}
      alt=""
      aria-hidden="true"
      title={title ?? lab.name}
      loading="lazy"
      className={cn('size-4 shrink-0 object-contain', className)}
    />
  );
}
