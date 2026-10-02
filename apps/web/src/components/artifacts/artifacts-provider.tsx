import {
  type ArtifactSummary,
  detectArtifactBlocks,
  type PublicArtifact,
  toolKey,
} from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArtifactPanel } from '~/components/artifacts/artifact-panel';
import {
  type ArtifactRef,
  ArtifactsContextProvider,
  type ArtifactsContextValue,
} from '~/components/artifacts/artifacts-context';
import { textOf } from '~/components/chat/message-content';
import { api } from '~/lib/api-client';

const lookupKey = (messageId: string, sourceKey: string) => `${messageId}\u0000${sourceKey}`;

function useArtifactPanel() {
  const [opened, setOpened] = useState<ArtifactRef | null>(null);
  const open = useCallback((artifact: ArtifactRef) => setOpened(artifact), []);
  const close = useCallback(() => setOpened(null), []);
  return { opened, open, close };
}

function lookups(refs: readonly ArtifactRef[]) {
  const byKey = new Map(refs.map((ref) => [lookupKey(ref.messageId, ref.sourceKey), ref]));
  const byId = new Map(refs.flatMap((ref) => (ref.id ? [[ref.id, ref] as const] : [])));
  return {
    find: (messageId: string, sourceKey: string) => byKey.get(lookupKey(messageId, sourceKey)),
    findById: (id: string) => byId.get(id),
    forMessage: (messageId: string) => refs.filter((ref) => ref.messageId === messageId),
  };
}

export const toRef = (artifact: ArtifactSummary): ArtifactRef => ({
  id: artifact.id,
  messageId: artifact.messageId,
  sourceKey: artifact.sourceKey,
  title: artifact.title,
  kind: artifact.kind,
  version: artifact.currentVersion,
});

/** Saved blocks the latest finished reply should have but the list does not show yet. */
function missingFromLatest(messages: readonly UIMessage[], refs: readonly ArtifactRef[]) {
  const latest = messages.at(-1);
  if (latest?.role !== 'assistant') return false;
  const keys = new Set(refs.map((ref) => lookupKey(ref.messageId, ref.sourceKey)));
  const blocks = detectArtifactBlocks(textOf(latest)).map((block) => block.key);
  const tools = latest.parts.flatMap((part) =>
    part.type === 'tool-create_artifact' &&
    'toolCallId' in part &&
    part.state === 'output-available'
      ? [toolKey(String(part.toolCallId))]
      : [],
  );
  return [...blocks, ...tools].some((key) => !keys.has(lookupKey(latest.id, key)));
}

/**
 * Artifacts of the open conversation, the cards' lookups and the side panel.
 * The list is read again when a reply finishes; a reply's artifacts are saved
 * as it is stored, so a few short retries cover a list read just before that.
 */
export function ThreadArtifactsProvider({
  threadId,
  messages,
  streaming,
  canEdit,
  children,
}: {
  threadId: string;
  messages: readonly UIMessage[];
  streaming: boolean;
  canEdit: boolean;
  children: ReactNode;
}) {
  const query = useQuery({
    queryKey: ['artifacts', threadId],
    queryFn: ({ signal }) =>
      api.get<{ artifacts: ArtifactSummary[] }>(
        `/artifacts?threadId=${encodeURIComponent(threadId)}`,
        { signal },
      ),
    staleTime: 30_000,
  });
  const { refetch } = query;
  const refs = useMemo(() => (query.data?.artifacts ?? []).map(toRef), [query.data]);

  const wasStreaming = useRef(streaming);
  const [retries, setRetries] = useState(0);
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      setRetries(0);
      void refetch();
    }
    wasStreaming.current = streaming;
  }, [refetch, streaming]);
  const missing = !streaming && query.isSuccess && missingFromLatest(messages, refs);
  useEffect(() => {
    if (!missing || retries >= 3) return;
    const timer = setTimeout(() => {
      setRetries((value) => value + 1);
      void refetch();
    }, 1_500);
    return () => clearTimeout(timer);
  }, [missing, retries, refetch]);

  const panel = useArtifactPanel();
  const value = useMemo<ArtifactsContextValue>(
    () => ({ ...lookups(refs), open: panel.open, mode: 'owner', canEdit }),
    [refs, panel.open, canEdit],
  );
  return (
    <ArtifactsContextProvider value={value}>
      {children}
      <ArtifactPanel artifact={panel.opened} onClose={panel.close} />
    </ArtifactsContextProvider>
  );
}

/** Artifacts on a share link: the shared version only, read-only, with the page's Markdown safety. */
export function PublicArtifactsProvider({
  artifacts,
  markdownProps,
  children,
}: {
  artifacts: readonly PublicArtifact[];
  markdownProps: ArtifactsContextValue['markdownProps'];
  children: ReactNode;
}) {
  const refs = useMemo(
    () =>
      artifacts.map(
        (artifact): ArtifactRef => ({
          id: null,
          messageId: artifact.messageId,
          sourceKey: artifact.sourceKey,
          title: artifact.title,
          kind: artifact.kind,
          version: artifact.version,
          content: artifact.content,
        }),
      ),
    [artifacts],
  );
  const panel = useArtifactPanel();
  const value = useMemo<ArtifactsContextValue>(
    () => ({ ...lookups(refs), open: panel.open, mode: 'public', canEdit: false, markdownProps }),
    [refs, panel.open, markdownProps],
  );
  return (
    <ArtifactsContextProvider value={value}>
      {children}
      <ArtifactPanel artifact={panel.opened} onClose={panel.close} />
    </ArtifactsContextProvider>
  );
}
