import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { artifactKindName } from '~/components/artifacts/artifact-labels';
import { ArtifactSource } from '~/components/artifacts/artifact-source';
import { useT } from '~/lib/i18n';
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
  const t = useT();
  const { draft, kind, writing } = view;
  const name = view.title ?? t('artifacts.draft.newArtifact');
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
    ? t('artifacts.draft.stateWriting')
    : draft.state === 'saved'
      ? t('artifacts.draft.stateSaved')
      : draft.state === 'failed'
        ? t('artifacts.draft.stateNotSaved')
        : t('artifacts.draft.stateStopped');
  return (
    <>
      <PanelHeader
        chrome={chrome}
        title={name}
        description={t('artifacts.draft.description', {
          kind: kind ? artifactKindName(kind, draft.language) : t('artifacts.kind.artifact'),
          state,
        })}
      />
      <section
        ref={scroller}
        aria-label={t('artifacts.draft.sourceOf', { name })}
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
            <ArtifactSource
              kind={kind}
              language={draft.language}
              content={draft.content}
              writing={writing}
            />
          ) : (
            <p className="p-4 text-sm text-[var(--text-muted)]">{t('artifacts.draft.preparing')}</p>
          )}
          {!writing && draft.state !== 'saved' && (
            <p role="alert" className="px-4 pb-4 text-sm text-[var(--danger-on-tint)]">
              {t('artifacts.draft.notSaved')}
            </p>
          )}
        </div>
      </section>
    </>
  );
}
