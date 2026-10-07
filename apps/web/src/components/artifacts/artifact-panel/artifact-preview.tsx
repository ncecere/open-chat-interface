import { ArtifactFrame } from '~/components/artifacts/artifact-frame';
import type { ArtifactRef } from '~/components/artifacts/artifacts-context';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';

/** The rendered artifact: sandboxed for HTML and SVG, OCI's Markdown renderer otherwise. */
export function ArtifactPreview({
  kind,
  content,
  title,
  markdownProps,
}: {
  kind: ArtifactRef['kind'];
  content: string;
  title: string;
  markdownProps?: {
    skipHtml?: boolean;
    urlTransform?: (value: string, key: string, node: unknown) => string | null;
  };
}) {
  if (kind === 'html' || kind === 'svg')
    return (
      <ArtifactFrame
        kind={kind}
        content={content}
        title={`${title} (preview)`}
        className="min-h-[60vh]"
      />
    );
  const markdown = kind === 'mermaid' ? `\`\`\`mermaid\n${content}\n\`\`\`` : content;
  return (
    <div className="p-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] sm:p-5">
      <Markdown className={MARKDOWN_PROSE} {...markdownProps}>
        {markdown}
      </Markdown>
    </div>
  );
}
