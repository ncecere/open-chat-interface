import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronsLeftRight,
  History,
  Keyboard,
  MessageSquareText,
  MoonStar,
  Palette,
  Paperclip,
  Plus,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { NAV_SECTIONS } from '~/components/admin/admin-layout';
import { Spinner } from '~/components/ui/spinner';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useCreateThread, useThreads } from '~/hooks/use-threads';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

const LISTBOX_ID = 'oci-command-palette-listbox';
const PENDING_PROMPT_KEY = 'oci.pendingPrompt';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  keywords?: string;
  icon: LucideIcon;
  onSelect: () => void | Promise<void>;
}

interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}

function matches(item: PaletteItem, query: string) {
  if (!query) return true;
  return `${item.label} ${item.keywords ?? ''}`.toLocaleLowerCase().includes(query);
}

/**
 * Global command and thread search. It is controlled so the app shell can open
 * it from either a visible search control or the Cmd/Ctrl+K shortcut.
 */
export function CommandPalette({
  open,
  onOpenChange,
  sidebarOpen,
  onSidebarOpenChange,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const { data: currentUser } = useCurrentUser();
  const { resolvedTheme, setTheme } = useTheme();
  const createThread = useCreateThread();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const normalizedDebouncedQuery = debouncedQuery.trim();
  const searchIsSettled = query.trim() === normalizedDebouncedQuery;

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setDebouncedQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  const { data: threads = [], isFetching: isSearchingThreads } = useThreads(
    normalizedDebouncedQuery || undefined,
  );

  const actionGroups = useMemo<PaletteGroup[]>(() => {
    const groups: PaletteGroup[] = [
      {
        id: 'chat',
        label: 'Chat',
        items: [
          {
            id: 'new-chat',
            label: 'New chat',
            keywords: 'start conversation home',
            icon: Plus,
            onSelect: () => navigate({ to: '/' }),
          },
          {
            id: 'history',
            label: 'Manage chat history',
            keywords: 'threads archive conversations',
            icon: History,
            onSelect: () => navigate({ to: '/settings/history' }),
          },
          {
            id: 'models',
            label: 'View all available models',
            keywords: 'ai providers',
            icon: Sparkles,
            onSelect: () => navigate({ to: '/settings/models' }),
          },
          {
            id: 'attachments',
            label: 'View all uploaded attachments',
            keywords: 'files uploads',
            icon: Paperclip,
            onSelect: () => navigate({ to: '/settings/attachments' }),
          },
        ],
      },
      {
        id: 'settings',
        label: 'Settings',
        items: [
          {
            id: 'account',
            label: 'Account settings',
            keywords: 'profile preferences',
            icon: Settings,
            onSelect: () => navigate({ to: '/settings' }),
          },
          {
            id: 'customize',
            label: 'Customize appearance',
            keywords: 'fonts density boring theme',
            icon: SlidersHorizontal,
            onSelect: () => navigate({ to: '/settings/customization' }),
          },
          {
            id: 'shortcuts',
            label: 'Show keyboard shortcuts',
            keywords: 'hotkeys commands',
            icon: Keyboard,
            onSelect: () => navigate({ to: '/settings/shortcuts' }),
          },
          {
            id: 'toggle-theme',
            label: `Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`,
            keywords: 'toggle appearance color mode',
            icon: resolvedTheme === 'dark' ? Palette : MoonStar,
            onSelect: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
          },
          {
            id: 'toggle-sidebar',
            label: `${sidebarOpen ? 'Close' : 'Open'} sidebar`,
            keywords: 'toggle collapse navigation',
            icon: ChevronsLeftRight,
            onSelect: () => onSidebarOpenChange(!sidebarOpen),
          },
        ],
      },
    ];

    if (currentUser?.user.role === 'admin' || currentUser?.user.role === 'auditor') {
      groups.push({
        id: 'admin',
        label: 'Admin',
        items: [
          {
            id: 'admin-dashboard',
            label: 'Open admin dashboard',
            keywords: 'administration users providers quotas',
            icon: Shield,
            onSelect: () => navigate({ to: '/admin' }),
          },
          // Built from the sidebar's own list, so a page added there is
          // reachable here without anybody remembering to add it twice.
          ...NAV_SECTIONS.flatMap((section) =>
            section.items
              .filter((item) => item.to !== '/admin')
              .map((item) => ({
                id: `admin-${item.to}`,
                label: item.label,
                keywords: `admin administration ${section.label}`,
                icon: item.icon,
                onSelect: () => navigate({ to: item.to }),
              })),
          ),
        ],
      });
    }

    return groups;
  }, [currentUser?.user.role, navigate, onSidebarOpenChange, resolvedTheme, setTheme, sidebarOpen]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const nextGroups: PaletteGroup[] = [];

    if (normalizedQuery && searchIsSettled && threads.length > 0) {
      nextGroups.push({
        id: 'threads',
        label: 'Threads',
        items: threads.map((thread) => ({
          id: `thread-${thread.id}`,
          label: thread.title,
          keywords: 'thread conversation',
          icon: MessageSquareText,
          onSelect: () => navigate({ to: '/chat/$threadId', params: { threadId: thread.id } }),
        })),
      });
    }

    for (const group of actionGroups) {
      const items = group.items.filter((item) => matches(item, normalizedQuery));
      if (items.length > 0) nextGroups.push({ ...group, items });
    }

    if (query.trim()) {
      const prompt = query.trim();
      nextGroups.push({
        id: 'query-action',
        label: 'Actions',
        items: [
          {
            id: 'new-chat-with-query',
            label: `New chat with query: “${prompt}”`,
            keywords: prompt,
            icon: Plus,
            onSelect: async () => {
              if (createThread.isPending) return;
              const { thread } = await createThread.mutateAsync(undefined);
              sessionStorage.setItem(PENDING_PROMPT_KEY, prompt);
              await navigate({ to: '/chat/$threadId', params: { threadId: thread.id } });
            },
          },
        ],
      });
    }

    return nextGroups;
  }, [actionGroups, createThread, navigate, normalizedQuery, query, searchIsSettled, threads]);

  const items = groups.flatMap((group) => group.items);
  const itemIds = items.map((item) => item.id).join('|');
  const safeSelectedIndex = items.length > 0 ? Math.min(selectedIndex, items.length - 1) : -1;
  const selectedItem = safeSelectedIndex >= 0 ? items[safeSelectedIndex] : undefined;
  const selectedItemId = selectedItem?.id;

  useEffect(() => {
    if (!open || !selectedItemId) return;
    document
      .getElementById(`oci-command-palette-option-${selectedItemId}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedItemId]);

  // Reset to the first best match whenever the result set changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemIds intentionally tracks result identity
  useEffect(() => setSelectedIndex(0), [query, itemIds]);

  async function selectItem(item: PaletteItem | undefined) {
    if (!item) return;

    try {
      await item.onSelect();
      onOpenChange(false);
    } catch {
      // Mutation hooks retain the request error; keep the palette open for retry.
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((current) => (items.length > 0 ? (current + 1) % items.length : 0));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((current) =>
        items.length > 0 ? (current - 1 + items.length) % items.length : 0,
      );
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setSelectedIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setSelectedIndex(Math.max(0, items.length - 1));
      return;
    }

    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void selectItem(selectedItem);
    }
  }

  let optionIndex = -1;
  const showThreadProgress = normalizedQuery.length > 0 && (!searchIsSettled || isSearchingThreads);

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
        >
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>

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
                        'flex min-h-9 w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm',
                        'transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
                        selected
                          ? 'border-[var(--border-strong)] bg-[var(--accent-soft)] text-[var(--text-primary)]'
                          : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]',
                      )}
                    >
                      <Icon className="text-[var(--text-muted)]" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
