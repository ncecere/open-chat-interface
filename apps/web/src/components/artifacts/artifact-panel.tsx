import {
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  PanelResizeHandle,
  useMeasuredWidth,
  usePanelWidth,
} from '~/components/artifacts/panel-resize';
import { Dialog, DialogContent } from '~/components/ui/dialog';
import { cn } from '~/lib/utils';
import { ArtifactPanelBody } from './artifact-panel/artifact-panel-body';
import { DraftBody } from './artifact-panel/draft-body';
import { FocusGuard, inertOthers } from './artifact-panel/full-screen-focus';
import type { Chrome } from './artifact-panel/panel-header';
import { type PanelView, viewKey } from './artifact-panel/panel-helpers';
import { useWritingAnnouncement } from './artifact-panel/use-writing-announcement';

export { artifactFilename, type PanelView } from './artifact-panel/panel-helpers';

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
