import {
  ARTIFACT_FILE_TYPES,
  ARTIFACT_KIND_LABELS,
  type ArtifactDetail,
  type ArtifactKind,
  type ArtifactVersionDetail,
  type DocumentFormat,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, Maximize2, Minimize2, Pencil, X } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ArtifactDraft } from '~/components/artifacts/artifact-drafts';
import { ArtifactFrame } from '~/components/artifacts/artifact-frame';
import { ArtifactSource } from '~/components/artifacts/artifact-source';
import { type ArtifactRef, useArtifacts } from '~/components/artifacts/artifacts-context';
import {
  PanelResizeHandle,
  useMeasuredWidth,
  usePanelWidth,
} from '~/components/artifacts/panel-resize';
import { ExportMenu, ExportNotice, useDocumentExport } from '~/components/chat/export-menu';
import { MARKDOWN_PROSE, Markdown } from '~/components/chat/markdown';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '~/components/ui/dialog';
import { PillTabs } from '~/components/ui/pill-tabs';
import { ApiError, api, saveBlob } from '~/lib/api-client';
import { cn } from '~/lib/utils';

type View = 'preview' | 'source' | 'versions';

/** What the panel shows: a saved artifact, or one a reply is writing now. */
export type PanelView =
  | { type: 'artifact'; ref: ArtifactRef }
  | {
      type: 'draft';
      draft: ArtifactDraft;
      title: string | null;
      kind: ArtifactKind | null;
      /** The reply is still writing it (false once saved, failed or stopped). */
      writing: boolean;
    };

/** The title made safe for a file name, without an extension. */
function filenameBase(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .toLowerCase() || 'artifact'
  );
}

/** A file name for a download: the title, made safe, with the kind's extension. */
export function artifactFilename(title: string, kind: ArtifactRef['kind']): string {
  return `${filenameBase(title)}.${ARTIFACT_FILE_TYPES[kind].extension}`;
}

function download(title: string, kind: ArtifactRef['kind'], content: string) {
  const blob = new Blob([content], { type: `${ARTIFACT_FILE_TYPES[kind].mimeType};charset=utf-8` });
  saveBlob(blob, artifactFilename(title, kind));
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

const viewKey = (view: PanelView) =>
  view.type === 'artifact'
    ? `artifact:${view.ref.id ?? `${view.ref.messageId}:${view.ref.sourceKey}`}`
    : `draft:${view.draft.toolCallId}`;

/** How the panel is framed: a dialog, or a region docked beside the conversation. */
interface Chrome {
  docked: boolean;
  headingId: string;
  onClose: (focusWasInside: boolean) => void;
  /** Filling the whole window (always a modal dialog then). */
  fullScreen: boolean;
  /** Absent where the panel cannot go full screen. */
  onToggleFullScreen?: () => void;
}

const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keeps Tab inside a full-screen panel: everything else is inert, so tabbing
 * past either end (including out of a preview's frame, whose key presses the
 * page never sees) lands here and is sent round to the other end.
 */
function FocusGuard({ to }: { to: 'first' | 'last' }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a focus guard only passes focus on.
    <span
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a focus guard must be reachable by Tab.
      tabIndex={0}
      data-focus-guard={to}
      className="pointer-events-none fixed size-px overflow-hidden opacity-0"
      onFocus={(event) => {
        const panel = event.currentTarget.closest('[data-artifact-panel]');
        const items = [...(panel?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])].filter(
          (item) => !item.hasAttribute('data-focus-guard'),
        );
        (to === 'first' ? items[0] : items.at(-1))?.focus();
      }}
    />
  );
}

/**
 * Makes everything outside `element` inert (the way a modal dialog does),
 * except live regions such as notifications, and returns how to undo it.
 * Elements that were already inert are left alone.
 */
function inertOthers(element: HTMLElement): () => void {
  const changed: Element[] = [];
  let node: Element = element;
  while (node.parentElement && node !== document.body) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || sibling.hasAttribute('inert')) continue;
      if (sibling.hasAttribute('aria-live') || /^(SCRIPT|STYLE|TEMPLATE)$/.test(sibling.tagName))
        continue;
      sibling.setAttribute('inert', '');
      changed.push(sibling);
    }
    node = node.parentElement;
  }
  return () => {
    for (const sibling of changed) sibling.removeAttribute('inert');
  };
}

function PanelHeading({ chrome, children }: { chrome: Chrome; children: ReactNode }) {
  if (!chrome.docked) return <DialogTitle className="truncate text-base">{children}</DialogTitle>;
  return (
    <h2
      id={chrome.headingId}
      tabIndex={-1}
      data-panel-heading=""
      className="truncate text-base font-semibold outline-none"
    >
      {children}
    </h2>
  );
}

function PanelDescription({ chrome, children }: { chrome: Chrome; children: ReactNode }) {
  if (!chrome.docked) return <DialogDescription className="text-xs">{children}</DialogDescription>;
  return <p className="text-xs text-[var(--text-muted)]">{children}</p>;
}

/**
 * The panel's header: title and description, the actions, then Full screen
 * and Close, each in its own column at the end, so the actions wrap before
 * they could ever run under either.
 */
function PanelHeader({
  chrome,
  title,
  description,
  toolbar,
  children,
}: {
  chrome: Chrome;
  title: string;
  description: ReactNode;
  toolbar?: ReactNode;
  children?: ReactNode;
}) {
  const fullScreenName = chrome.fullScreen ? 'Exit full screen' : 'Full screen';
  const close = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Close"
      data-panel-close=""
      className="shrink-0"
      onClick={chrome.docked ? () => chrome.onClose(true) : undefined}
    >
      <X aria-hidden="true" />
    </Button>
  );
  return (
    <header
      data-panel-header=""
      className="flex items-start gap-2 border-b border-[var(--border-subtle)] px-4 py-3 sm:px-5"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-[8rem] flex-1">
          <PanelHeading chrome={chrome}>{title}</PanelHeading>
          <PanelDescription chrome={chrome}>{description}</PanelDescription>
        </div>
        {toolbar}
        {children}
      </div>
      {chrome.onToggleFullScreen && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={fullScreenName}
          title={fullScreenName}
          data-panel-fullscreen=""
          className="shrink-0"
          onClick={chrome.onToggleFullScreen}
        >
          {chrome.fullScreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </Button>
      )}
      {chrome.docked ? close : <DialogClose asChild>{close}</DialogClose>}
    </header>
  );
}

/** Announces when a source starts and finishes being written, never each token. */
function useWritingAnnouncement(view: PanelView | null): string {
  const [message, setMessage] = useState('');
  const announced = useRef<{ id: string; finished: boolean } | null>(null);
  useEffect(() => {
    const current = announced.current;
    if (view?.type === 'draft') {
      const name = view.title ?? 'the artifact';
      if (view.writing && view.title && current?.id !== view.draft.toolCallId) {
        announced.current = { id: view.draft.toolCallId, finished: false };
        setMessage(`Writing ${view.title}…`);
      } else if (!view.writing && current?.id === view.draft.toolCallId && !current.finished) {
        current.finished = true;
        setMessage(
          view.draft.state === 'saved'
            ? `Finished writing ${name}.`
            : `Writing ${name} stopped before it was saved.`,
        );
      }
    } else if (view?.type === 'artifact' && current && !current.finished) {
      current.finished = true;
      setMessage(`Finished writing ${view.ref.title}.`);
    }
  }, [view]);
  return message;
}

/**
 * The artifact panel, with Preview, Source and, for the owner, Versions; or
 * the source of an artifact as a reply writes it.
 *
 * On wide screens in a conversation it is docked beside the conversation: a
 * complementary region that never traps focus, so the composer and messages
 * stay usable; Escape inside it or Close closes it. Elsewhere (phones, share
 * links) it is a modal dialog, full screen on phones; Escape leaves an edit
 * first, then closes, and focus returns to the card that opened it.
 *
 * Full screen (the person's choice, never automatic) makes either one a modal
 * dialog over the whole window, above the sidebar and top bar: everything
 * else is inert, focus stays on the toggle and Tab cycles inside. Escape
 * leaves an edit, then full screen, then closes the panel.
 */
export function ArtifactPanel({
  view,
  onClose,
  docked = false,
  focusRequest = 0,
  panelRef,
  fullScreen = false,
  onFullScreenChange,
}: {
  view: PanelView | null;
  onClose: (focusWasInside: boolean) => void;
  docked?: boolean;
  /** Changes when focus should move into the docked panel (it was opened by the person). */
  focusRequest?: number;
  panelRef?: Ref<HTMLElement>;
  /** Whether the panel fills the window; the owner resets it when the panel closes or changes. */
  fullScreen?: boolean;
  onFullScreenChange?: (fullScreen: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const headingId = useId();
  const panelId = useId();
  const status = useWritingAnnouncement(view);
  const aside = useRef<HTMLElement | null>(null);
  const [asideElement, setAsideElement] = useState<HTMLElement | null>(null);
  const measured = useMeasuredWidth(docked && !fullScreen ? asideElement : null);
  const panelWidth = usePanelWidth(measured);
  // Focus goes to the toggle after the person enters or leaves full screen.
  const focusToggle = useRef(false);
  const setFullScreen = useCallback(
    (next: boolean) => {
      focusToggle.current = true;
      onFullScreenChange?.(next);
    },
    [onFullScreenChange],
  );
  const chrome: Chrome = {
    docked,
    headingId,
    onClose,
    fullScreen,
    onToggleFullScreen: onFullScreenChange ? () => setFullScreen(!fullScreen) : undefined,
  };
  const setAside = useCallback(
    (element: HTMLElement | null) => {
      aside.current = element;
      setAsideElement(element);
      if (typeof panelRef === 'function') panelRef(element);
      else if (panelRef) panelRef.current = element;
    },
    [panelRef],
  );

  useEffect(() => {
    if (docked && focusRequest) document.getElementById(headingId)?.focus();
  }, [docked, focusRequest, headingId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when full screen changes.
  useLayoutEffect(() => {
    if (!focusToggle.current) return;
    focusToggle.current = false;
    document.querySelector<HTMLElement>('[data-artifact-panel] [data-panel-fullscreen]')?.focus();
  }, [fullScreen]);

  // Docked and full screen: a modal dialog, so the rest of the page is inert.
  const shown = view !== null;
  useEffect(() => {
    const element = aside.current;
    if (!docked || !fullScreen || !shown || !element) return;
    return inertOthers(element);
  }, [docked, fullScreen, shown]);

  /** Escape: leave an edit, then full screen; true when it did either. */
  const stepBack = () => {
    if (editing) setEditing(false);
    else if (fullScreen) setFullScreen(false);
    else return false;
    return true;
  };

  const body = view ? (
    view.type === 'draft' ? (
      <DraftBody key={viewKey(view)} view={view} chrome={chrome} />
    ) : (
      <ArtifactPanelBody
        key={viewKey(view)}
        artifact={view.ref}
        editing={editing}
        setEditing={setEditing}
        chrome={chrome}
      />
    )
  ) : null;
  const announcer = (
    <p className="sr-only" role="status" aria-live="polite" data-writing-status="">
      {status}
    </p>
  );

  if (docked) {
    if (!view) return null;
    // The default is a share of the layout; once the person resizes the
    // panel, its width is theirs (clamped to the window).
    const dockedSize = cn(
      'mb-2 mr-2 mt-16 min-w-[22rem] shrink-0',
      !panelWidth.custom && 'w-[45%] max-w-[56rem]',
    );
    const dockedStyle = panelWidth.custom ? { width: `${panelWidth.width}px` } : undefined;
    return (
      <>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role and aria-modal switch together with full screen. */}
        <aside
          ref={setAside}
          id={panelId}
          style={fullScreen ? undefined : dockedStyle}
          role={fullScreen ? 'dialog' : undefined}
          aria-modal={fullScreen ? true : undefined}
          aria-labelledby={headingId}
          data-artifact-panel=""
          data-docked=""
          data-full-screen={fullScreen ? '' : undefined}
          onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
            // A menu inside the panel closes itself first (and marks the key used).
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            if (!stepBack()) onClose(true);
          }}
          className={cn(
            // Positioned: its visually hidden status texts are laid out inside it.
            'flex min-h-0 flex-col overflow-hidden bg-[var(--bg-elevated)]',
            fullScreen
              ? // Above the sidebar and top bar (z-30); menus, dialogs and toasts
                // it opens are portalled after it, so they still come first.
                'fixed inset-0 z-50'
              : // Below the conversation controls that hang from the top bar.
                cn(
                  'relative',
                  dockedSize,
                  'rounded-xl border border-[var(--border-subtle)] shadow-[var(--shadow-popover)]',
                ),
          )}
        >
          {fullScreen && <FocusGuard to="last" />}
          {!fullScreen && (
            <PanelResizeHandle
              width={panelWidth.width}
              min={panelWidth.min}
              max={panelWidth.max}
              windowWidth={panelWidth.windowWidth}
              controls={panelId}
              onResize={panelWidth.set}
            />
          )}
          {body}
          {announcer}
          {fullScreen && <FocusGuard to="first" />}
        </aside>
        {/* Keeps the conversation's width while the panel fills the window. */}
        {fullScreen && (
          <div
            aria-hidden="true"
            data-panel-placeholder=""
            className={dockedSize}
            style={dockedStyle}
          />
        )}
      </>
    );
  }

  return (
    <Dialog
      open={view !== null}
      onOpenChange={(open) => {
        if (!open) {
          setEditing(false);
          onClose(false);
        }
      }}
    >
      {view && (
        <DialogContent
          data-artifact-panel=""
          closeButton={false}
          aria-modal="true"
          data-full-screen={fullScreen ? '' : undefined}
          onEscapeKeyDown={(event) => {
            // Escape leaves an edit, then full screen; the next one closes the panel.
            if (stepBack()) event.preventDefault();
          }}
          className={cn(
            'flex flex-col gap-0 overflow-hidden p-0',
            // Phones and full screen: the whole screen. Wider screens: a panel on the right.
            'inset-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none',
            fullScreen
              ? 'border-0'
              : 'md:left-auto md:right-0 md:w-[min(56rem,92vw)] md:rounded-none md:border-y-0 md:border-r-0',
          )}
        >
          {body}
          {announcer}
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * An artifact as a reply writes it: the source streams in, following the end
 * unless the person scrolls up. It switches to the saved artifact's preview
 * once it is saved (the provider swaps the view).
 */
function DraftBody({
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
            <p role="alert" className="px-4 pb-4 text-sm text-[var(--danger-foreground)]">
              This artifact was not saved.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function ArtifactPanelBody({
  artifact,
  editing,
  setEditing,
  chrome,
}: {
  artifact: ArtifactRef;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  chrome: Chrome;
}) {
  const context = useArtifacts();
  const owner = context?.mode === 'owner' && artifact.id !== null;
  const id = artifact.id ?? '';
  const [view, setView] = useState<View>('preview');
  const [selected, setSelected] = useState<number | null>(artifact.openVersion ?? null);
  const [copied, setCopied] = useState(false);
  const viewId = useId();

  const detail = useQuery({
    queryKey: ['artifact', id],
    queryFn: ({ signal }) =>
      api.get<ArtifactDetail>(`/artifacts/${encodeURIComponent(id)}`, { signal }),
    enabled: owner,
  });
  const current = detail.data?.artifact.currentVersion ?? artifact.version;
  const older = selected !== null && selected !== current ? selected : null;
  const version = useQuery({
    queryKey: ['artifact', id, 'version', older],
    queryFn: ({ signal }) =>
      api.get<ArtifactVersionDetail>(`/artifacts/${encodeURIComponent(id)}/versions/${older}`, {
        signal,
      }),
    enabled: owner && older !== null,
  });

  const title = detail.data?.artifact.title ?? artifact.title;
  const shownVersion = older ?? current;
  const content = !owner
    ? (artifact.content ?? '')
    : older !== null
      ? version.data?.content
      : detail.data?.content;
  const loading = owner && (older !== null ? version.isLoading : detail.isLoading);
  const loadError = owner && (older !== null ? version.isError : detail.isError);
  const canEdit =
    owner && Boolean(context?.canEdit) && artifact.kind === 'markdown' && older === null;
  // File output: the API turns Markdown documents into files; other kinds are
  // downloaded as they are. Owners only (never on a share page).
  const canExport = owner && artifact.kind === 'markdown';
  const exportPath = useCallback(
    (format: DocumentFormat) =>
      `/artifacts/${encodeURIComponent(id)}/export?format=${format}${
        older !== null ? `&version=${older}` : ''
      }`,
    [id, older],
  );
  const exporting = useDocumentExport(exportPath, filenameBase(title));

  const tabs = [
    { id: 'preview' as const, label: 'Preview' },
    { id: 'source' as const, label: 'Source' },
    ...(owner ? [{ id: 'versions' as const, label: 'Versions' }] : []),
  ];

  async function copy() {
    if (content === undefined) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <>
      <PanelHeader
        chrome={chrome}
        title={title}
        description={
          <>
            {ARTIFACT_KIND_LABELS[artifact.kind]} · version {shownVersion}
            {older !== null ? ` of ${current}` : ''}
          </>
        }
        toolbar={
          <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Artifact">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void copy()}
              disabled={content === undefined}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => content !== undefined && download(title, artifact.kind, content)}
              disabled={content === undefined}
            >
              <Download aria-hidden="true" />
              Download
            </Button>
            {canExport && (
              <ExportMenu
                markdown={content ?? ''}
                state={exporting}
                disabled={content === undefined || editing}
              />
            )}
            {canEdit && !editing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                disabled={content === undefined}
              >
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            )}
          </div>
        }
      >
        <span className="sr-only" role="status" aria-live="polite">
          {copied ? 'Copied to the clipboard' : ''}
        </span>
        {canExport && <ExportNotice state={exporting} className="basis-full" />}
      </PanelHeader>

      {editing && canEdit && content !== undefined ? (
        <DocumentEditor
          artifactId={id}
          initial={content}
          baseVersion={current}
          onDone={() => {
            setEditing(false);
            setSelected(null);
            setView('preview');
          }}
        />
      ) : (
        <>
          <div className="border-b border-[var(--border-subtle)] px-4 py-2 sm:px-5">
            <PillTabs tabs={tabs} active={view} onChange={setView} label="View" controls={viewId} />
          </div>
          <section
            id={viewId}
            role="tabpanel"
            aria-label={tabs.find((tab) => tab.id === view)?.label}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a long source scrolls; the keyboard must reach it.
            tabIndex={0}
            className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent-bright)]"
          >
            {view === 'versions' ? (
              <VersionList
                detail={detail.data}
                selected={shownVersion}
                onSelect={(next) => {
                  setSelected(next === current ? null : next);
                  setView('preview');
                }}
              />
            ) : loading ? (
              <p role="status" className="p-4 text-sm text-[var(--text-muted)]">
                Loading…
              </p>
            ) : loadError || content === undefined ? (
              <p role="alert" className="p-4 text-sm text-[var(--danger-foreground)]">
                This artifact could not be loaded.
              </p>
            ) : view === 'source' ? (
              <ArtifactSource kind={artifact.kind} content={content} />
            ) : (
              <ArtifactPreview
                kind={artifact.kind}
                content={content}
                title={title}
                markdownProps={context?.markdownProps}
              />
            )}
          </section>
        </>
      )}
    </>
  );
}

/** The rendered artifact: sandboxed for HTML and SVG, OCI's Markdown renderer otherwise. */
function ArtifactPreview({
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

function VersionList({
  detail,
  selected,
  onSelect,
}: {
  detail: ArtifactDetail | undefined;
  selected: number;
  onSelect: (version: number) => void;
}) {
  if (!detail)
    return (
      <p role="status" className="p-4 text-sm text-[var(--text-muted)]">
        Loading…
      </p>
    );
  return (
    <ol className="divide-y divide-[var(--border-subtle)]" aria-label="Versions, newest first">
      {detail.versions.map((entry) => (
        <li key={entry.version}>
          <button
            type="button"
            onClick={() => onSelect(entry.version)}
            aria-current={entry.version === selected ? 'true' : undefined}
            className={cn(
              'flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-[var(--bg-control)] sm:px-5',
              entry.version === selected && 'bg-[var(--bg-control)]',
            )}
          >
            <span className="font-medium text-[var(--text-primary)]">
              Version {entry.version}
              {entry.version === detail.artifact.currentVersion ? ' (current)' : ''}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {entry.source === 'person' ? 'Edited by you' : 'By the assistant'} ·{' '}
              {formatDate(entry.createdAt)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Editing a Markdown document: saving makes a new version; nothing is overwritten. */
function DocumentEditor({
  artifactId,
  initial,
  baseVersion,
  onDone,
}: {
  artifactId: string;
  initial: string;
  baseVersion: number;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const editorId = useId();
  const save = useMutation({
    mutationFn: () =>
      api.post(`/artifacts/${encodeURIComponent(artifactId)}/versions`, {
        content: draft,
        baseVersion,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] }),
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
      ]);
      onDone();
    },
  });
  const unchanged = draft === initial;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !unchanged && draft.trim()) {
      event.preventDefault();
      save.mutate();
    }
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged && draft.trim()) save.mutate();
      }}
    >
      <label htmlFor={editorId} className="text-sm font-medium text-[var(--text-primary)]">
        Edit document
      </label>
      <textarea
        id={editorId}
        // biome-ignore lint/a11y/noAutofocus: the person chose to edit; focus belongs in the editor.
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck
        className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--border-strong)] bg-[var(--bg-control)] p-3 font-mono text-sm leading-relaxed text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent-bright)]"
      />
      {save.error && (
        <p role="alert" className="text-sm text-[var(--danger-foreground)]">
          {save.error instanceof ApiError ? save.error.message : 'The document could not be saved.'}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={unchanged || !draft.trim() || save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save as new version'}
        </Button>
      </div>
    </form>
  );
}
