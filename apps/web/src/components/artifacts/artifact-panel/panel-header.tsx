import { Maximize2, Minimize2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { type PanelResize, PanelWidthButtons } from '~/components/artifacts/panel-resize';
import { Button } from '~/components/ui/button';
import { DialogClose, DialogDescription, DialogTitle } from '~/components/ui/dialog';
import { useT } from '~/lib/i18n';

/** How the panel is framed: a dialog, or a region docked beside the conversation. */
export interface Chrome {
  docked: boolean;
  headingId: string;
  onClose: (focusWasInside: boolean) => void;
  /** Filling the whole window (always a modal dialog then). */
  fullScreen: boolean;
  /** Absent where the panel cannot go full screen. */
  onToggleFullScreen?: () => void;
  /** Wider and Narrower for the docked panel; absent where it has no handle to drag. */
  resize?: PanelResize;
}

/**
 * The title wraps: beside Copy and Download it was cut to "Walk7 Research
 * Dataset ..." with no way to read the rest, and a tooltip would not help on
 * touch (#312, as #244).
 */
const HEADING_WRAP = 'break-words text-base [overflow-wrap:anywhere]';

function PanelHeading({ chrome, children }: { chrome: Chrome; children: ReactNode }) {
  if (!chrome.docked)
    return (
      <DialogTitle dir="auto" className={HEADING_WRAP}>
        {children}
      </DialogTitle>
    );
  return (
    <h2
      id={chrome.headingId}
      tabIndex={-1}
      data-panel-heading=""
      dir="auto"
      className={`${HEADING_WRAP} font-semibold outline-none`}
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
  const t = useT();
  const fullScreenName = chrome.fullScreen
    ? t('artifacts.panel.exitFullScreen')
    : t('artifacts.panel.fullScreen');
  const close = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={t('artifacts.panel.close')}
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
      {chrome.resize && <PanelWidthButtons resize={chrome.resize} />}
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
