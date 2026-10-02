import { parseHighlights } from '~/lib/search-highlight';

/** Renders a marked search snippet with `<mark>` around matches, as text nodes only. */
export function HighlightedText({ text }: { text: string }) {
  return (
    <>
      {parseHighlights(text).map((segment) =>
        segment.highlighted ? (
          <mark
            key={segment.start}
            className="rounded-sm bg-[var(--accent-soft)] px-0.5 font-semibold text-[var(--text-primary)]"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </>
  );
}
