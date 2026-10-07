import { ARTIFACT_KIND_LABELS } from '@oci/shared';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { ArtifactSource } from '~/components/artifacts/artifact-source';
import { type Chrome, PanelHeader } from './panel-header';
import type { PanelView } from './panel-helpers';

/**
 * An artifact as a reply writes it: the source streams in, following the end
 * unless the person scrolls up. It switches to the saved artifact's preview
 * once it is saved (the provider swaps the view).
 */
export function DraftBody({
  view,
  chrome,
}: {
  view: Extract<PanelView, { type: 'draft' }>;
  chrome: Chrome;
}) {
  const { draft, kind, writing } = view;
  const name = view.title ?? 'New artifact';
  const scroller = useRef<HTMLElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const toEnd = useCallback(() => {
    const element = scroller.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows each new piece of text.
  useLayoutEffect(toEnd, [draft.content, toEnd]);
  useEffect(() => {
    // Highlighting arrives after the text; keep following as it grows.
    const element = inner.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(toEnd);
    observer.observe(element);
    return () => observer.disconnect();
  }, [toEnd]);

  const state = writing
    ? 'being written…'
    : draft.state === 'saved'
      ? 'saved'
      : draft.state === 'failed'
        ? 'not saved'
        : 'stopped';
  return (
    <>
      <PanelHeader
        chrome={chrome}
        title={name}
        description={`${kind ? ARTIFACT_KIND_LABELS[kind] : 'Artifact'} · ${state}`}
      />
      <section
        ref={scroller}
        aria-label={`Source of ${name}`}
        aria-busy={writing}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access.
        tabIndex={0}
        data-draft-source=""
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
      >
        <div ref={inner}>
          {draft.mode === 'content' ? (
            <ArtifactSource kind={kind} content={draft.content} writing={writing} />
          ) : (
            <p className="p-4 text-sm text-[var(--text-muted)]">Preparing…</p>
          )}
          {!writing && draft.state !== 'saved' && (
            <p role="alert" className="px-4 pb-4 text-sm text-[var(--danger-on-tint)]">
              This artifact was not saved.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
