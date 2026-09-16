import { useNavigate } from '@tanstack/react-router';
import { MessageSquareText, Plus } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useCreateThread, useThreads } from '~/hooks/use-threads';
import type { CommandPaletteProps, PaletteGroup, PaletteItem } from './types';
import { usePaletteActions } from './use-palette-actions';

const PENDING_PROMPT_KEY = 'oci.pendingPrompt';

function matches(item: PaletteItem, query: string) {
  if (!query) return true;
  return `${item.label} ${item.keywords ?? ''}`.toLocaleLowerCase().includes(query);
}

export function useCommandPaletteState({
  open,
  onOpenChange,
  sidebarOpen,
  onSidebarOpenChange,
}: CommandPaletteProps) {
  const navigate = useNavigate();
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

  const actionGroups = usePaletteActions({ sidebarOpen, onSidebarOpenChange });

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

  const showThreadProgress = normalizedQuery.length > 0 && (!searchIsSettled || isSearchingThreads);
  return {
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
  };
}
