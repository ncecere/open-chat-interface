import { Maximize2, Minimize2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '~/components/ui/button';
import { DialogClose, DialogDescription, DialogTitle } from '~/components/ui/dialog';

/** How the panel is framed: a dialog, or a region docked beside the conversation. */
export interface Chrome {
  docked: boolean;
  headingId: string;
  onClose: (focusWasInside: boolean) => void;
  /** Filling the whole window (always a modal dialog then). */
  fullScreen: boolean;
  /** Absent where the panel cannot go full screen. */
  onToggleFullScreen?: () => void;
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
export function PanelHeader({
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
