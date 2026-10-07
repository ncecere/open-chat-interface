/**
 * WCAG 2.4.1 Bypass Blocks.
 *
 * The sidebar puts every thread ahead of the main panel in tab order, so a
 * keyboard user would otherwise traverse the whole conversation list before
 * reaching the composer. The link stays out of the visual layout until it takes
 * focus, at which point it must be plainly visible.
 */
export function SkipLink({
  targetId = 'main-content',
  inert,
}: {
  targetId?: string;
  /** While a modal covers the page it would skip to (the phone sidebar drawer, #191). */
  inert?: boolean;
}) {
  return (
    <a
      href={`#${targetId}`}
      inert={inert || undefined}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-[var(--bg-elevated)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--text-primary)] focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-[var(--accent-bright)]"
    >
      Skip to main content
    </a>
  );
}
