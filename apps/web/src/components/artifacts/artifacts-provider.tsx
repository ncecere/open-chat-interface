import {
  type ArtifactSummary,
  artifactOfToolPart,
  detectArtifactBlocks,
  type PublicArtifact,
  toolKey,
} from '@oci/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ArtifactDraft,
  artifactDraftOf,
  artifactDraftsOf,
  writesSource,
} from '~/components/artifacts/artifact-drafts';
import { ArtifactPanel, type PanelView } from '~/components/artifacts/artifact-panel';
import {
  type ArtifactRef,
  ArtifactsContextProvider,
  type ArtifactsContextValue,
} from '~/components/artifacts/artifacts-context';
import { shownReply } from '~/components/artifacts/declined-artifacts';
import { textOf } from '~/components/chat/message-content';
import { useMediaQuery } from '~/hooks/use-media-query';
import { api } from '~/lib/api-client';
import { useAutoOpenArtifacts } from '~/providers/theme-provider';

/**
 * From this width the panel is docked beside the conversation (Tailwind's
 * `lg`): with the sidebar open that still leaves the conversation about
 * 400px next to a panel of at least 22rem. Narrower, it is a modal dialog.
 */
const DOCKED_PANEL_QUERY = '(min-width: 1024px)';

const lookupKey = (messageId: string, sourceKey: string) => `${messageId}\u0000${sourceKey}`;

function lookups(refs: readonly ArtifactRef[]) {
  const byKey = new Map(refs.map((ref) => [lookupKey(ref.messageId, ref.sourceKey), ref]));
  const byId = new Map(refs.flatMap((ref) => (ref.id ? [[ref.id, ref] as const] : [])));
  return {
    find: (messageId: string, sourceKey: string) => byKey.get(lookupKey(messageId, sourceKey)),
    findById: (id: string) => byId.get(id),
    forMessage: (messageId: string) => refs.filter((ref) => ref.messageId === messageId),
  };
}
type Lookups = ReturnType<typeof lookups>;

const toRef = (artifact: ArtifactSummary): ArtifactRef => ({
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
  // Calls that saved something (not those declined as reply content, #201).
  const tools = latest.parts.flatMap((part) =>
    part.type === 'tool-create_artifact' &&
    'toolCallId' in part &&
    artifactOfToolPart(part as unknown as Record<string, unknown>)
      ? [toolKey(String(part.toolCallId))]
      : [],
  );
  return [...blocks, ...tools].some((key) => !keys.has(lookupKey(latest.id, key)));
}

function findDraft(messages: readonly UIMessage[], messageId: string, toolCallId: string) {
  const message = messages.findLast((candidate) => candidate.id === messageId);
  const part = message?.parts.find(
    (candidate) => (candidate as { toolCallId?: unknown }).toolCallId === toolCallId,
  );
  return message && part ? artifactDraftOf(message.id, part) : null;
}

/** The saved artifact a finished call made or changed, once the list has it. */
function savedOf(draft: ArtifactDraft, lookup: Lookups): ArtifactRef | undefined {
  if (draft.state !== 'saved') return undefined;
  if (draft.tool === 'create_artifact')
    return lookup.find(draft.messageId, toolKey(draft.toolCallId));
  return draft.artifactId ? lookup.findById(draft.artifactId) : undefined;
}

const blockIndex = (ref: ArtifactRef) => Number(ref.sourceKey.slice('block:'.length));

type Target =
  | { type: 'artifact'; ref: ArtifactRef }
  | { type: 'draft'; messageId: string; toolCallId: string };

interface Opened {
  target: Target;
  /** Bumped when focus should move into the docked panel; 0 leaves focus where it is. */
  focusRequest: number;
  /** Where focus goes back to when the person closes a docked panel. */
  returnTo: HTMLElement | null;
}

/** What has happened in the reply being written now (or the last one), for auto-open. */
interface ReplySession {
  /** The panel opened by itself for this reply; it does so once at most. */
  opened: boolean;
  /** The person closed the panel during this reply: it stays closed. */
  dismissed: boolean;
  /** The person opened something themselves during this reply. */
  manual: boolean;
  /** An auto-opened draft whose title is not known yet, to announce once it is. */
  announce: string | null;
  /** Calls already in the reply when this run began (a reply continued after an approval). */
  known: ReadonlySet<string>;
}

/** Focus for a closed docked panel: where the person came from, the card, or the composer. */
function focusAfterClose(opened: Opened) {
  const { target, returnTo } = opened;
  const cardKey =
    target.type === 'draft' ? toolKey(target.toolCallId) : (target.ref.sourceKey ?? '');
  const card = document.querySelector<HTMLElement>(
    `[data-artifact-card="${CSS.escape(cardKey)}"]:not([disabled])`,
  );
  const composer = document.querySelector<HTMLElement>('[aria-label="Message input"]');
  const next = returnTo?.isConnected ? returnTo : (card ?? composer);
  next?.focus();
}

/**
 * Artifacts of the open conversation, the cards' lookups and the panel.
 *
 * The list is read again when a reply finishes (a few short retries cover a
 * list read just before the reply is stored) and as soon as an artifact tool
 * call has saved, so the panel can show the saved artifact without waiting
 * for the rest of the reply.
 *
 * On wide screens the panel is docked beside the conversation and opens by
 * itself (unless the person turned that off) for replies written in this
 * browser tab: at the first artifact a reply starts writing through the
 * tools, showing its source as it arrives, or else at the first artifact
 * found in the reply's code blocks once it is finished. Never for replies
 * loaded from history, never when the person opened or closed something
 * during the reply, never over a panel the person made full screen (nor in
 * full screen itself), and never moving focus.
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
  const queryClient = useQueryClient();
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
  const lookup = useMemo(() => lookups(refs), [refs]);

  const docked = useMediaQuery(DOCKED_PANEL_QUERY);
  const autoOpen = useAutoOpenArtifacts();
  // Replies already there when the conversation opened are history, never live.
  const [history] = useState(() => new Set(messages.map((message) => message.id)));
  const reply = useRef<ReplySession | null>(null);
  const [fence, setFence] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  // Only ever the person's choice; it ends when the panel closes or shows something else.
  const [fullScreen, setFullScreen] = useState(false);
  const fullScreenRef = useRef(false);
  fullScreenRef.current = fullScreen && opened !== null;
  const [announcement, setAnnouncement] = useState('');
  const focusCount = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const savedSeen = useRef(new Set<string>());

  const last = messages.at(-1);
  const latest = last?.role === 'assistant' ? last : undefined;
  const live = latest !== undefined && !history.has(latest.id);
  // Not a Markdown document that, as written so far, would be declined (#201):
  // the panel opens once it is long enough to keep, or once it is saved.
  const drafts = useMemo(() => (latest ? artifactDraftsOf(shownReply(latest)) : []), [latest]);

  const wasStreaming = useRef(streaming);
  const [retries, setRetries] = useState(0);
  useEffect(() => {
    if (!wasStreaming.current && streaming) {
      reply.current = {
        opened: false,
        dismissed: false,
        manual: false,
        announce: null,
        known: new Set(drafts.map((draft) => draft.toolCallId)),
      };
      setFence(null);
    }
    if (wasStreaming.current && !streaming) {
      setRetries(0);
      void refetch();
      const session = reply.current;
      // A finished live reply may have saved artifacts from its code blocks.
      if (session && live && latest && !session.opened && !session.dismissed && !session.manual)
        setFence(latest.id);
    }
    wasStreaming.current = streaming;
  }, [refetch, streaming, live, latest, drafts]);
  const missing = !streaming && query.isSuccess && missingFromLatest(messages, refs);
  useEffect(() => {
    if (!missing || retries >= 3) return;
    const timer = setTimeout(() => {
      setRetries((value) => value + 1);
      void refetch();
    }, 1_500);
    return () => clearTimeout(timer);
  }, [missing, retries, refetch]);

  const openAuto = useCallback((target: Target, title: string | null) => {
    const session = reply.current;
    if (!session) return;
    session.opened = true;
    // Never over what the person is looking at full screen.
    if (fullScreenRef.current) return;
    setOpened({ target, focusRequest: 0, returnTo: null });
    if (title) setAnnouncement(`Opened artifact: ${title}`);
    else if (target.type === 'draft') session.announce = target.toolCallId;
  }, []);

  // The tool path: a live reply's artifact calls.
  useEffect(() => {
    const session = reply.current;
    if (!session || !live) return;
    for (const draft of drafts) {
      if (draft.state !== 'saved' || savedSeen.current.has(draft.toolCallId)) continue;
      // Saved: show it without waiting for the rest of the reply.
      savedSeen.current.add(draft.toolCallId);
      void refetch();
      if (draft.tool === 'update_artifact' && draft.artifactId)
        void queryClient.invalidateQueries({ queryKey: ['artifact', draft.artifactId] });
    }
    if (session.announce) {
      const draft = drafts.find((candidate) => candidate.toolCallId === session.announce);
      const existing = draft?.artifactId ? lookup.findById(draft.artifactId) : undefined;
      const title = draft?.title ?? existing?.title;
      if (title || draft?.state !== 'writing') {
        session.announce = null;
        setAnnouncement(`Opened artifact: ${title ?? 'new artifact'}`);
      }
    }
    if (!streaming || session.opened || session.dismissed || session.manual) return;
    if (!autoOpen || !docked) return;
    const draft = drafts.find(
      (candidate) =>
        candidate.state !== 'failed' &&
        !session.known.has(candidate.toolCallId) &&
        // A new artifact's kind first: a short Markdown one would be declined (#201).
        (candidate.tool !== 'create_artifact' || candidate.kind !== null),
    );
    if (!draft) return;
    if (writesSource(draft)) {
      const existing = draft.artifactId ? lookup.findById(draft.artifactId) : undefined;
      openAuto(
        { type: 'draft', messageId: draft.messageId, toolCallId: draft.toolCallId },
        draft.title ?? existing?.title ?? null,
      );
    } else if (draft.mode === 'edits' && draft.artifactId) {
      // A revision by edits has no source to watch: open the artifact itself.
      const existing = lookup.findById(draft.artifactId);
      if (existing) openAuto({ type: 'artifact', ref: existing }, existing.title);
    }
  }, [drafts, live, streaming, autoOpen, docked, lookup, refetch, queryClient, openAuto]);

  // The code-block path: the first artifact saved from a finished live reply.
  useEffect(() => {
    if (!fence) return;
    const session = reply.current;
    if (!session || session.opened || session.dismissed || session.manual) {
      setFence(null);
      return;
    }
    const [first] = lookup
      .forMessage(fence)
      .filter((ref) => ref.sourceKey.startsWith('block:'))
      .sort((a, b) => blockIndex(a) - blockIndex(b));
    if (first) {
      setFence(null);
      if (autoOpen && docked) openAuto({ type: 'artifact', ref: first }, first.title);
      return;
    }
    // Detection and the list retries take a few seconds at most.
    const timer = setTimeout(() => setFence(null), 10_000);
    return () => clearTimeout(timer);
  }, [fence, lookup, autoOpen, docked, openAuto]);

  // A draft becomes the saved artifact's preview once there is one, unless the
  // person has opened something else meanwhile (then `opened` changed).
  useEffect(() => {
    if (opened?.target.type !== 'draft') return;
    const { messageId, toolCallId } = opened.target;
    const draft = findDraft(messages, messageId, toolCallId);
    if (!draft) {
      setOpened(null);
      return;
    }
    const saved = savedOf(draft, lookup);
    if (!saved) return;
    const focusInside = panel.current?.contains(document.activeElement) ?? false;
    setOpened((current) =>
      current === opened
        ? {
            ...current,
            target: { type: 'artifact', ref: saved },
            focusRequest: focusInside ? ++focusCount.current : current.focusRequest,
          }
        : current,
    );
  }, [opened, messages, lookup]);

  useEffect(() => {
    if (!opened) setFullScreen(false);
  }, [opened]);

  const open = useCallback((ref: ArtifactRef) => {
    if (reply.current) reply.current.manual = true;
    setFullScreen(false);
    setOpened({
      target: { type: 'artifact', ref },
      focusRequest: ++focusCount.current,
      returnTo: document.activeElement as HTMLElement | null,
    });
  }, []);
  const openDraft = useCallback((messageId: string, toolCallId: string) => {
    if (reply.current) reply.current.manual = true;
    setFullScreen(false);
    setOpened({
      target: { type: 'draft', messageId, toolCallId },
      focusRequest: ++focusCount.current,
      returnTo: document.activeElement as HTMLElement | null,
    });
  }, []);
  const close = useCallback(
    (focusWasInside: boolean) => {
      if (reply.current) reply.current.dismissed = true;
      setFence(null);
      setOpened(null);
      setFullScreen(false);
      // A dialog returns focus itself; a docked panel hands it back here.
      if (focusWasInside && opened) {
        const closed = opened;
        requestAnimationFrame(() => focusAfterClose(closed));
      }
    },
    [opened],
  );

  const view = useMemo<PanelView | null>(() => {
    if (!opened) return null;
    if (opened.target.type === 'artifact') return { type: 'artifact', ref: opened.target.ref };
    const draft = findDraft(messages, opened.target.messageId, opened.target.toolCallId);
    if (!draft) return null;
    const existing = draft.artifactId ? lookup.findById(draft.artifactId) : undefined;
    return {
      type: 'draft',
      draft,
      title: draft.title ?? existing?.title ?? null,
      kind: draft.kind ?? existing?.kind ?? null,
      writing: draft.state === 'writing' && streaming,
    };
  }, [opened, messages, lookup, streaming]);

  const value = useMemo<ArtifactsContextValue>(
    () => ({ ...lookup, open, openDraft, mode: 'owner', canEdit, docked }),
    [lookup, open, openDraft, canEdit, docked],
  );
  return (
    <ArtifactsContextProvider value={value}>
      {/* Positioned, so the visually hidden announcer below is laid out (and
          clipped) here rather than against an ancestor outside the scroller. */}
      <div className="relative flex h-full min-h-0" data-artifacts-layout="">
        <div className="flex h-full min-w-0 flex-1 flex-col">{children}</div>
        {docked && (
          <ArtifactPanel
            docked
            view={view}
            onClose={close}
            focusRequest={opened?.focusRequest ?? 0}
            panelRef={panel}
            fullScreen={fullScreen}
            onFullScreenChange={setFullScreen}
          />
        )}
        <p className="sr-only" aria-live="polite" aria-atomic="true" data-artifact-announcer="">
          {announcement}
        </p>
      </div>
      {!docked && (
        <ArtifactPanel
          view={view}
          onClose={close}
          fullScreen={fullScreen}
          onFullScreenChange={setFullScreen}
        />
      )}
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
  const [opened, setOpened] = useState<ArtifactRef | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const open = useCallback((ref: ArtifactRef) => {
    setFullScreen(false);
    setOpened(ref);
  }, []);
  const value = useMemo<ArtifactsContextValue>(
    () => ({ ...lookups(refs), open, mode: 'public', canEdit: false, markdownProps }),
    [refs, open, markdownProps],
  );
  // Share pages keep the dialog, opened only by the viewer.
  return (
    <ArtifactsContextProvider value={value}>
      {children}
      <ArtifactPanel
        view={opened ? { type: 'artifact', ref: opened } : null}
        onClose={() => {
          setOpened(null);
          setFullScreen(false);
        }}
        fullScreen={fullScreen}
        onFullScreenChange={setFullScreen}
      />
    </ArtifactsContextProvider>
  );
}
