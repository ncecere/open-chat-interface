import {
  type ArtifactBlock,
  artifactOfToolPart,
  isToolPart,
  splitArtifactSegments,
  toolIdOfPart,
  toolKey,
} from '@oci/shared';
import type { UIMessage } from 'ai';
import { useMemo } from 'react';
import { ArtifactCard } from '~/components/artifacts/artifact-card';
import { useArtifacts } from '~/components/artifacts/artifacts-context';
import { Markdown, type MarkdownProps } from '~/components/chat/markdown';

type ReplyMarkdownProps = Omit<MarkdownProps, 'children'> & { messageId: string; text: string };

/**
 * A reply's text with each saved artifact block shown as a card that opens
 * the panel. HTML and SVG blocks are replaced by their card; a Mermaid diagram
 * keeps its inline drawing with the card below it. A block with no saved
 * artifact (still streaming, not saved, or outside a conversation page) is
 * shown as the code block it is.
 */
export function ReplyMarkdown({ messageId, text, ...markdown }: ReplyMarkdownProps) {
  const artifacts = useArtifacts();
  const segments = useMemo(
    () => (artifacts ? splitArtifactSegments(text) : null),
    [artifacts, text],
  );
  if (!artifacts || !segments || (segments.length === 1 && segments[0]?.type === 'markdown'))
    return <Markdown {...markdown}>{text}</Markdown>;
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

/** Cards for artifacts this reply created or revised through the artifact tools. */
export function ToolArtifactCards({ message }: { message: UIMessage }) {
  const artifacts = useArtifacts();
  if (!artifacts) return null;
  const cards = message.parts.flatMap((part) => {
    if (!isToolPart(part)) return [];
    const result = artifactOfToolPart(part);
    if (!result) return [];
    const created = toolIdOfPart(part) === 'create_artifact';
    const artifact = created
      ? artifacts.find(message.id, toolKey(part.toolCallId))
      : artifacts.findById(result.artifactId);
    if (!artifact) return [];
    return [
      <ArtifactCard
        key={part.toolCallId}
        // A revision opens the artifact; its card names the version this reply made.
        artifact={created ? artifact : { ...artifact, version: result.version }}
        onOpen={artifacts.open}
        note={created ? undefined : 'Updated'}
      />,
    ];
  });
  return cards.length ? <div>{cards}</div> : null;
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
