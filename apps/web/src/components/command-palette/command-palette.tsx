import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { Spinner } from '~/components/ui/spinner';
import { cn } from '~/lib/utils';
import type { CommandPaletteProps } from './types';
import { useCommandPaletteState } from './use-command-palette-state';

const LISTBOX_ID = 'oci-command-palette-listbox';

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
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (consumeKeepFocus()) event.preventDefault();
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
                    <button
                      key={item.id}
                      id={`oci-command-palette-option-${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onPointerMove={() => setSelectedIndex(index)}
                      onClick={() => void selectItem(item)}
                      className={cn(
                        'flex min-h-9 w-full gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm',
                        item.content ? 'items-start' : 'items-center',
                        'transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                        selected
                          ? 'border-[var(--border-strong)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                          : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
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
                    </button>
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
