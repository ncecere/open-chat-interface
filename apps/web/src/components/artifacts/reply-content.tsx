import { type ArtifactBlock, detectArtifactBlocks, type ReplySegment } from '@oci/shared';
import { useMemo } from 'react';
import { ArtifactCard } from '~/components/artifacts/artifact-card';
import { useArtifacts } from '~/components/artifacts/artifacts-context';
import { Markdown, type MarkdownProps } from '~/components/chat/markdown';

type ReplyMarkdownProps = Omit<MarkdownProps, 'children'> & {
  messageId: string;
  /** The reply's whole text: artifact block keys are positions in it. */
  text: string;
  /** The part of `text` to show (one run of the reply's text); all of it when absent. */
  range?: { start: number; end: number };
};

/**
 * The segments of `text` within [start, end): Markdown around the artifact
 * blocks that start there. Detection runs on the whole text, so a block's key
 * is the same whichever range shows it (`splitArtifactSegments`, per range).
 */
function segmentsInRange(text: string, start: number, end: number): ReplySegment[] {
  const blocks = detectArtifactBlocks(text).filter(
    (block) => block.start >= start && block.start < end,
  );
  const segments: ReplySegment[] = [];
  let cursor = start;
  for (const block of blocks) {
    const before = text.slice(cursor, block.start);
    if (before.trim()) segments.push({ type: 'markdown', text: before });
    segments.push({ type: 'artifact', block, raw: text.slice(block.start, block.end) });
    cursor = block.end + 1;
  }
  const after = text.slice(cursor, Math.max(cursor, end));
  if (after.trim() || segments.length === 0) segments.push({ type: 'markdown', text: after });
  return segments;
}

/**
 * A reply's text with each saved artifact block shown as a card that opens
 * the panel. HTML and SVG blocks are replaced by their card; a Mermaid diagram
 * keeps its inline drawing with the card below it. A block with no saved
 * artifact (still streaming, not saved, or outside a conversation page) is
 * shown as the code block it is.
 */
export function ReplyMarkdown({ messageId, text, range, ...markdown }: ReplyMarkdownProps) {
  const artifacts = useArtifacts();
  const start = range?.start ?? 0;
  const end = range?.end ?? text.length;
  const segments = useMemo(
    () => (artifacts ? segmentsInRange(text, start, end) : null),
    [artifacts, text, start, end],
  );
  if (!artifacts || !segments || (segments.length === 1 && segments[0]?.type === 'markdown'))
    return <Markdown {...markdown}>{text.slice(start, end)}</Markdown>;
  let previous = 'start';
  return (
    <>
      {segments.map((segment) => {
        if (segment.type === 'markdown')
          return (
            <Markdown key={`text-after-${previous}`} {...markdown}>
              {segment.text}
            </Markdown>
          );
        previous = segment.block.key;
        return (
          <ArtifactSlot
            key={segment.block.key}
            messageId={messageId}
            block={segment.block}
            raw={segment.raw}
            markdown={markdown}
          />
        );
      })}
    </>
  );
}

function ArtifactSlot({
  messageId,
  block,
  raw,
  markdown,
}: {
  messageId: string;
  block: ArtifactBlock;
  raw: string;
  markdown: Omit<MarkdownProps, 'children'>;
}) {
  const artifacts = useArtifacts();
  const artifact = artifacts?.find(messageId, block.key);
  if (!artifacts || !artifact) return <Markdown {...markdown}>{raw}</Markdown>;
  const card = <ArtifactCard artifact={artifact} onOpen={artifacts.open} />;
  if (block.kind !== 'mermaid') return card;
  return (
    <>
      <Markdown {...markdown}>{raw}</Markdown>
      {card}
    </>
  );
}

/**
 * Cards for the artifacts a reply created through a tool, where the reply's
 * tool parts are not available (share links carry only step summaries).
 */
export function CreatedArtifactCards({ messageId }: { messageId: string }) {
  const artifacts = useArtifacts();
  const created = artifacts
    ?.forMessage(messageId)
    .filter((ref) => ref.sourceKey.startsWith('tool:'));
  if (!artifacts || !created?.length) return null;
  return (
    <div>
      {created.map((artifact) => (
        <ArtifactCard key={artifact.sourceKey} artifact={artifact} onOpen={artifacts.open} />
      ))}
    </div>
  );
}
