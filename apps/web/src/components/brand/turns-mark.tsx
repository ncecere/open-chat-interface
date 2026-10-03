import { cn } from '~/lib/utils';

/**
 * Open Chat Interface's mark, "Turns": a question in a blue bubble, then the
 * answer as two lines, on a dark tile.
 *
 * Source: oci-assets `logo/turns/mark-small.svg` (the drawing for 20 to 47 px,
 * with heavier answer lines), commit 9ce4afe. The favicons in
 * apps/web/public (favicon.svg, favicon.ico, apple-touch-icon.png) are copied
 * unchanged from the same commit's `logo/turns/` and `logo/turns/png/`.
 *
 * Usage rules from the logo README: the tile mark reads on light and dark
 * surfaces, so it is used everywhere; its colours are fixed and never follow
 * an instance's accent theme; it is decorative beside the live-text name.
 */
export function TurnsMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
      data-brand-mark="turns"
      className={cn('size-7 shrink-0', className)}
    >
      <rect width="64" height="64" rx="14" fill="#171717" />
      <path
        d="M32.5 11H44.5A7.5 7.5 0 0 1 52 18.5V29.5H32.5A7.5 7.5 0 0 1 25 22V18.5A7.5 7.5 0 0 1 32.5 11Z"
        fill="#51a2ff"
      />
      <path
        d="M15.75 40H48.25M15.75 51H34.25"
        fill="none"
        stroke="#fafafa"
        strokeWidth="7.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
