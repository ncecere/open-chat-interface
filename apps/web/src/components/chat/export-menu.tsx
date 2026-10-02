import { DOCUMENT_FORMAT_INFO, type DocumentFormat, markdownHasTable } from '@oci/shared';
import { FileDown } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { api, apiErrorMessage, saveBlob } from '~/lib/api-client';
import { cn } from '~/lib/utils';

/**
 * File output (v0.9): "Export as…" for a reply or a Markdown document. The
 * API generates the file; the browser fetches it, so a refusal (no tables, too
 * large, too many downloads) is shown as the API's own message rather than as
 * a failed download page.
 */

/** Menu order: documents first, the spreadsheet (tables only) last. */
const MENU_ORDER: readonly DocumentFormat[] = ['docx', 'pdf', 'pptx', 'xlsx'];

/**
 * The formats offered for some Markdown. Spreadsheets need a table; the check
 * is the same cheap line scan the API makes before generating anything, so
 * the option appears exactly when the API would take the request.
 */
export function exportFormatsFor(markdown: string): DocumentFormat[] {
  const tables = markdownHasTable(markdown);
  return MENU_ORDER.filter((format) => format !== 'xlsx' || tables);
}

function formatMenuLabel(format: DocumentFormat): string {
  return `${DOCUMENT_FORMAT_INFO[format].label} (.${DOCUMENT_FORMAT_INFO[format].extension})`;
}

interface DocumentExport {
  /** The format being prepared, or null. */
  busy: DocumentFormat | null;
  error: string | null;
  run: (format: DocumentFormat) => Promise<void>;
  dismiss: () => void;
}

/**
 * Fetches `pathFor(format)` and saves the file under the name the API gives
 * (or `fallbackName` and the format's extension). One export at a time.
 */
export function useDocumentExport(
  pathFor: (format: DocumentFormat) => string,
  fallbackName: string,
): DocumentExport {
  const [busy, setBusy] = useState<DocumentFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(
    async (format: DocumentFormat) => {
      if (running.current) return;
      running.current = true;
      setBusy(format);
      setError(null);
      try {
        const file = await api.download(pathFor(format));
        saveBlob(
          file.blob,
          file.filename ?? `${fallbackName}.${DOCUMENT_FORMAT_INFO[format].extension}`,
        );
      } catch (failure) {
        setError(
          apiErrorMessage(
            failure,
            `The ${DOCUMENT_FORMAT_INFO[format].description} file could not be downloaded. Check your connection and try again.`,
          ),
        );
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [pathFor, fallbackName],
  );

  return { busy, error, run, dismiss: useCallback(() => setError(null), []) };
}

/**
 * The menu button and its formats. `markdown` decides whether a spreadsheet is
 * offered; it is read only when the menu opens. Radix provides the menu
 * semantics: `aria-haspopup`, arrow keys, Escape and focus back on the button.
 */
export function ExportMenu({
  markdown,
  state,
  compact = false,
  disabled = false,
}: {
  markdown: string;
  state: DocumentExport;
  /** An icon button (reply actions) rather than a labelled one (artifact panel). */
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = state.busy ? 'Preparing file…' : 'Export as…';
  return (
    // Not modal: a modal menu marks the rest of the page aria-hidden while it is
    // still focusable (axe: aria-hidden-focus). Escape, an outside click or a
    // choice still close it, and focus returns to the button.
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      {/* Not disabled while a file is prepared: focus is back on this button
          by then, and disabling a focused button drops focus to the page. */}
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="ghost"
          size={compact ? 'icon-sm' : 'sm'}
          aria-label={compact ? label : undefined}
          title={compact ? label : undefined}
          data-export-menu=""
        >
          <FileDown aria-hidden="true" className={cn(state.busy && 'animate-pulse')} />
          {!compact && label}
        </Button>
      </DropdownMenuTrigger>
      {open && (
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Export as</DropdownMenuLabel>
          {exportFormatsFor(markdown).map((format) => (
            <DropdownMenuItem
              key={format}
              disabled={state.busy !== null}
              onSelect={() => void state.run(format)}
            >
              {formatMenuLabel(format)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

/** The live progress and the inline error of an export, under its button. */
export function ExportNotice({ state, className }: { state: DocumentExport; className?: string }) {
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {state.busy ? `Preparing the ${DOCUMENT_FORMAT_INFO[state.busy].description} file…` : ''}
      </span>
      {state.error && (
        <p
          role="alert"
          className={cn(
            'flex items-start gap-2 text-xs text-[var(--danger-foreground)]',
            className,
          )}
        >
          <span className="min-w-0 flex-1">{state.error}</span>
          <button
            type="button"
            className="shrink-0 underline underline-offset-2"
            onClick={state.dismiss}
          >
            Dismiss
          </button>
        </p>
      )}
    </>
  );
}
