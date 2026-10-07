import { type ArtifactKind, normalizeCodeLanguage } from '@oci/shared';
import { useEffect, useRef, useState } from 'react';
import { HighlightedCode, MARKDOWN_PROSE } from '~/components/chat/markdown';
import { cn } from '~/lib/utils';

/**
 * The Shiki language for an artifact's source. Mermaid uses its `mmd` alias:
 * a `mermaid` fence would be drawn as a diagram rather than shown as code. A
 * code artifact's is its own language (#298).
 */
export function sourceLanguage(kind: ArtifactKind | null, language?: string | null): string {
  switch (kind) {
    case 'code':
      return normalizeCodeLanguage(language);
    case 'html':
      return 'html';
    case 'svg':
      return 'xml';
    case 'mermaid':
      return 'mmd';
    case 'markdown':
      return 'markdown';
    default:
      return 'text';
  }
}

/**
 * Above this many characters the source is shown as plain text: highlighting
 * runs on the page's main thread, and a source near the 512 KB artifact limit
 * would hold it for seconds.
 */
export const HIGHLIGHT_LIMIT = 50_000;
/** While a source is being written, it is highlighted again at most this often. */
const STREAMING_HIGHLIGHT_MS = 400;

/** `value`, updated at most every `ms` while `throttle` holds; at once otherwise. */
function useThrottled<T>(value: T, ms: number, throttle: boolean): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (!throttle) {
      setShown(value);
      return;
    }
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms, throttle]);
  return throttle ? shown : value;
}

const PLAIN =
  'm-0 whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-[var(--text-secondary)] sm:p-5';

/**
 * An artifact's source, highlighted like code blocks in replies (same
 * renderer, theme and wrap preference). Very large sources are shown as plain
 * text with a note; a source being written is highlighted a few times a second
 * rather than on every token.
 */
export function ArtifactSource({
  kind,
  language,
  content,
  writing = false,
}: {
  kind: ArtifactKind | null;
  /** A code artifact's language (#298). */
  language?: string | null;
  content: string;
  writing?: boolean;
}) {
  const large = content.length > HIGHLIGHT_LIMIT;
  const highlighted = useThrottled(content, STREAMING_HIGHLIGHT_MS, writing && !large);
  if (large)
    return (
      <div data-artifact-source="plain">
        <p role="note" className="px-4 pt-3 text-xs text-[var(--text-muted)] sm:px-5">
          Syntax highlighting is off for sources over{' '}
          {new Intl.NumberFormat().format(HIGHLIGHT_LIMIT)} characters.
        </p>
        <pre className={PLAIN}>
          <code>{content}</code>
        </pre>
      </div>
    );
  return (
    <div
      data-artifact-source="highlighted"
      className={cn(
        MARKDOWN_PROSE,
        'p-3 text-xs sm:p-4',
        // The panel scrolls the source in both directions, so a long line is
        // reachable with the keyboard from the panel itself.
        '[&_[data-streamdown=code-block-body]]:!overflow-visible',
        '[&_[data-streamdown=code-block]]:!my-0',
      )}
    >
      <HighlightedCode source={highlighted} language={sourceLanguage(kind, language)} />
    </div>
  );
}
