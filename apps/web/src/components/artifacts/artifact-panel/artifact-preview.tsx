import { ArtifactFrame } from '~/components/artifacts/artifact-frame';
import { ArtifactSource } from '~/components/artifacts/artifact-source';
import type { ArtifactRef } from '~/components/artifacts/artifacts-context';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';

/**
 * The rendered artifact: sandboxed for HTML and SVG, highlighted text for
 * code, OCI's Markdown renderer otherwise.
 */
export function ArtifactPreview({
  kind,
  language,
  content,
  title,
  markdownProps,
}: {
  kind: ArtifactRef['kind'];
  language?: string | null;
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
  // Code is shown as code, every character as written: never read as HTML or
  // Markdown, which dropped `<inventory.csv>` as a tag (#298). So is a kind a
  // later release adds, which this one cannot know how to render.
  if (kind !== 'markdown' && kind !== 'mermaid')
    return <ArtifactSource kind={kind} language={language} content={content} />;
  const markdown = kind === 'mermaid' ? `\`\`\`mermaid\n${content}\n\`\`\`` : content;
  return (
    <div className="p-4 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] sm:p-5">
      <Markdown className={MARKDOWN_PROSE} {...markdownProps}>
        {markdown}
      </Markdown>
    </div>
  );
}
