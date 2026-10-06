import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import {
  ACTIVE_OPTION_RING,
  HIGHLIGHTED_ROW_TEXT,
  HOVERED_ROW_TEXT,
} from '~/components/ui/item-focus';
import { Spinner } from '~/components/ui/spinner';
import { useFocusReturn } from '~/hooks/use-focus-return';
import { keepHiddenContentInert } from '~/lib/inert-hidden';
import { cn } from '~/lib/utils';
import type { CommandPaletteProps } from './types';
import { useCommandPaletteState } from './use-command-palette-state';

const LISTBOX_ID = 'oci-command-palette-listbox';

// The palette hides the page; it is also made inert (#172).
keepHiddenContentInert();

/** Global command and thread search, controlled by the app shell. */
export function CommandPalette(props: CommandPaletteProps) {
  const { open, onOpenChange } = props;
  const {
    inputRef,
    query,
    setQuery,
    selectedItem,
    groups,
    items,
    safeSelectedIndex,
    setSelectedIndex,
    selectItem,
    handleInputKeyDown,
    showThreadProgress,
    threadAnnouncement,
    consumeKeepFocus,
  } = useCommandPaletteState(props);
  const focusReturn = useFocusReturn();
  let optionIndex = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-[10vh] z-50 flex max-h-[min(32rem,calc(100dvh-2rem))] w-[calc(100vw-1.5rem)]',
            'max-w-[32rem] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-strong)]',
            'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-popover)] outline-none',
            'sm:top-1/2 sm:-translate-y-1/2',
          )}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            focusReturn.onOpenAutoFocus();
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (consumeKeepFocus()) event.preventDefault();
            // Back to the composer or the Search button that opened it (#128).
            focusReturn.onCloseAutoFocus(event);
          }}
        >
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          <p role="status" aria-live="polite" className="sr-only">
            {threadAnnouncement}
          </p>

          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4">
            <Search className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
            <input
              ref={inputRef}
              role="combobox"
              aria-label="Type a command or search your threads"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={LISTBOX_ID}
              aria-activedescendant={
                selectedItem ? `oci-command-palette-option-${selectedItem.id}` : undefined
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Type a command or search your threads..."
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
            />
            {showThreadProgress && <Spinner className="shrink-0" />}
            <kbd className="hidden rounded border border-[var(--border-subtle)] bg-[var(--bg-control)] px-1.5 py-0.5 text-[0.625rem] text-[var(--text-muted)] sm:block">
              ESC
            </kbd>
          </div>

          <div
            id={LISTBOX_ID}
            role="listbox"
            aria-label="Suggestions"
            className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 py-2"
          >
            {/* Options as a listbox has them (#176): focus stays in the search
                field, which points at the selected option, so an option is not a
                button (each was a Tab stop). A fieldset is a group, named by its
                legend, which a listbox may hold. */}
            {groups.map((group) => (
              <fieldset key={group.id} className="m-0 mb-2 min-w-0 border-0 p-0 last:mb-0">
                <legend className="w-full px-2 pb-1 pt-1 text-[0.6875rem] font-semibold text-[var(--text-muted)]">
                  {group.label}
                </legend>
                {group.items.map((item) => {
                  optionIndex += 1;
                  const index = optionIndex;
                  const selected = index === safeSelectedIndex;
                  const Icon = item.icon;

                  return (
                    <div
                      key={item.id}
                      id={`oci-command-palette-option-${item.id}`}
                      role="option"
                      // Out of the Tab order; the search field's arrow keys move between options.
                      tabIndex={-1}
                      aria-selected={selected}
                      onPointerMove={() => setSelectedIndex(index)}
                      // The search field keeps focus; a click only chooses.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void selectItem(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void selectItem(item);
                      }}
                      className={cn(
                        'flex min-h-9 w-full cursor-pointer gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm',
                        item.content ? 'items-start' : 'items-center',
                        'transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                        // The active option gets the focus ring the model picker uses: the
                        // border and wash alone were 1.5:1 in light (#135).
                        selected
                          ? cn(
                              'border-transparent bg-[var(--accent-soft)] text-[var(--text-primary)]',
                              ACTIVE_OPTION_RING,
                              // A result's snippet stays readable on the wash (#188).
                              HIGHLIGHTED_ROW_TEXT,
                            )
                          : cn(
                              'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-control-hover)] hover:text-[var(--text-primary)]',
                              HOVERED_ROW_TEXT,
                            ),
                      )}
                    >
                      <Icon
                        className={cn('text-[var(--text-muted)]', item.content && 'mt-0.5')}
                        aria-hidden="true"
                      />
                      {item.content ? (
                        <span className="flex min-w-0 flex-1 flex-col">{item.content}</span>
                      ) : (
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      )}
                      {item.shortcut && (
                        <span className="hidden shrink-0 gap-1 sm:flex" data-shortcut>
                          {item.shortcut.map((key) => (
                            <kbd
                              key={key}
                              className="rounded border border-[var(--border-subtle)] bg-[var(--bg-control)] px-1.5 py-0.5 text-[0.625rem] text-[var(--text-muted)]"
                            >
                              {key}
                            </kbd>
                          ))}
                        </span>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}

            {items.length === 0 && !showThreadProgress && (
              <p className="px-3 py-10 text-center text-sm text-[var(--text-muted)]">
                No commands or threads found.
              </p>
            )}
          </div>

          <div className="flex min-h-10 shrink-0 items-center justify-end gap-3 border-t border-[var(--border-subtle)] px-3 text-[0.6875rem] text-[var(--text-muted)]">
            <span className="hidden items-center gap-1 sm:flex">
              <kbd className="rounded bg-[var(--bg-control)] px-1.5 py-0.5">↑↓</kbd>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded bg-[var(--bg-control)] px-1.5 py-0.5">↵</kbd>
              Open selected
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
