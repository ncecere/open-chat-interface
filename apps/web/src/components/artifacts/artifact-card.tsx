import { type ArtifactKind, artifactKindLabel } from '@oci/shared';
import { ChevronRight, FileCode2, FileImage, FileTerminal, FileText, Workflow } from 'lucide-react';
import { type ArtifactRef, useArtifacts } from '~/components/artifacts/artifacts-context';
import { cn } from '~/lib/utils';

const ARTIFACT_ICONS: Record<ArtifactKind, typeof FileCode2> = {
  html: FileCode2,
  svg: FileImage,
  mermaid: Workflow,
  markdown: FileText,
  code: FileTerminal,
};

/** "HTML · version 2"; a code artifact by its language, "Python · version 1" (#298). */
export function artifactMeta(artifact: Pick<ArtifactRef, 'kind' | 'version' | 'language'>): string {
  return `${artifactKindLabel(artifact.kind, artifact.language)} · version ${artifact.version}`;
}

/**
 * The button every artifact card is made of. A card that is being written
 * (`live`) and the saved card that follows it are the same element, so focus
 * stays on it when the artifact is saved.
 */
export function ArtifactCardButton({
  kind,
  title,
  meta,
  label,
  onOpen,
  live = false,
  preview,
  cardKey,
  arrow = true,
  className,
}: {
  kind: ArtifactKind | null;
  title: string;
  meta: string;
  /** The accessible name, for example "Open artifact: Sales chart". */
  label: string;
  onOpen?: () => void;
  /** Being written: a small streaming indicator instead of the arrow. */
  live?: boolean;
  /** The last lines written so far, shown small under the title. */
  preview?: readonly string[];
  /** Marks the card so focus can come back to it from the panel. */
  cardKey: string;
  /** The arrow that says the card opens; off where a details chevron sits beside it. */
  arrow?: boolean;
  className?: string;
}) {
  const docked = useArtifacts()?.docked ?? false;
  // A kind a later release adds has no icon here; without the fallback the
  // card had no component to draw and broke the conversation, as the
  // previous release does on a code artifact (#298).
  const Icon = (kind && ARTIFACT_ICONS[kind]) || FileCode2;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      // Docked beside the conversation, the panel is a region, not a dialog.
      aria-haspopup={docked ? undefined : 'dialog'}
      aria-label={label}
      data-artifact-card={cardKey}
      data-live={live ? '' : undefined}
      className={cn(
        'my-3 flex w-full max-w-md items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/50 px-3 py-2.5 text-left transition-colors hover:bg-[var(--bg-control-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-bright)] disabled:cursor-default disabled:hover:bg-[var(--bg-control)]/50',
        className,
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
        <Icon className="size-4 text-[var(--text-secondary)]" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        {/* The title wraps rather than ending in an ellipsis: a tooltip is no
            help on touch, and the card is the only place the full title shows
            before the panel opens (#336, as the panel's own title, #312). */}
        <span
          dir="auto"
          className="block wrap-anywhere text-sm font-medium text-[var(--text-primary)]"
        >
          {title}
        </span>
        <span className="block wrap-anywhere text-xs text-[var(--text-muted)]">{meta}</span>
        {preview && preview.length > 0 && (
          <span
            data-live-preview=""
            className="mt-1.5 block border-l-2 border-[var(--border-subtle)] pl-2 font-mono text-[0.6875rem] leading-4 text-[var(--text-muted)]"
          >
            {preview.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines are a moving window.
              <span key={index} className="block truncate whitespace-pre">
                {line || '\u00a0'}
              </span>
            ))}
          </span>
        )}
      </span>
      {live ? (
        <span
          className="flex shrink-0 items-center gap-1"
          aria-hidden="true"
          data-streaming-indicator=""
        >
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="size-1.5 rounded-full bg-[var(--accent-bright)] motion-safe:animate-pulse"
              style={{ animationDelay: `${dot * 0.2}s` }}
            />
          ))}
        </span>
      ) : arrow ? (
        <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      ) : null}
    </button>
  );
}

/**
 * A saved artifact in a reply: one button that opens the panel. Its name says
 * what opens ("Open artifact: Sales chart"), and focus returns here when the
 * panel closes.
 */
export function ArtifactCard({
  artifact,
  onOpen,
  note,
}: {
  artifact: ArtifactRef;
  onOpen: (artifact: ArtifactRef) => void;
  /** For example "Updated" on a reply that revised an existing artifact. */
  note?: string;
}) {
  return (
    <ArtifactCardButton
      kind={artifact.kind}
      title={artifact.title}
      meta={`${note ? `${note} · ` : ''}${artifactMeta(artifact)}`}
      label={`Open artifact: ${artifact.title}`}
      onOpen={() => onOpen(artifact)}
      cardKey={artifact.sourceKey}
    />
  );
}
