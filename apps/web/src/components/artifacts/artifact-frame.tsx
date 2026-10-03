import { useEffect, useRef, useState } from 'react';
import {
  ARTIFACT_FRAME_SANDBOX,
  ARTIFACT_FRAME_URL,
  buildArtifactDocument,
  FRAME_DOCUMENT,
  FRAME_READY,
  loadArtifactLibraries,
} from '~/lib/artifact-sandbox';
import { cn } from '~/lib/utils';

/**
 * An HTML or SVG artifact in OCI's sandbox (see lib/artifact-sandbox.ts).
 * The same component renders artifacts in conversations and on share links.
 *
 * The host page asks for its document once it has loaded; only a message
 * from this frame's own window is answered, and only once per load, so the
 * artifact cannot ask the page for anything else.
 */
export function ArtifactFrame({
  kind,
  content,
  title,
  className,
}: {
  kind: 'html' | 'svg';
  content: string;
  title: string;
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // A new document gets a fresh frame: nothing survives from the previous one.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    setHtml(null);
    setFailed(false);
    loadArtifactLibraries(content)
      .then((libraries) => {
        if (!live) return;
        setHtml(buildArtifactDocument(kind, content, libraries));
        setGeneration((value) => value + 1);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [kind, content]);

  useEffect(() => {
    if (html === null) return;
    let sent = false;
    const answer = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (sent || !target || event.source !== target) return;
      if ((event.data as { type?: unknown } | null)?.type !== FRAME_READY) return;
      sent = true;
      // The frame's origin is opaque, so it can only be addressed as '*'.
      target.postMessage({ type: FRAME_DOCUMENT, html }, '*');
    };
    window.addEventListener('message', answer);
    return () => window.removeEventListener('message', answer);
  }, [html]);

  if (failed)
    return (
      <p role="alert" className="p-4 text-sm text-[var(--danger-foreground)]">
        This artifact could not be prepared.
      </p>
    );
  if (html === null)
    return (
      <p role="status" className="p-4 text-sm text-[var(--text-muted)]">
        Preparing preview…
      </p>
    );
  return (
    <iframe
      key={generation}
      ref={frame}
      title={title}
      src={ARTIFACT_FRAME_URL}
      sandbox={ARTIFACT_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      data-artifact-frame=""
      className={cn('block size-full border-0 bg-white', className)}
    />
  );
}
