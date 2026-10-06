import { type MemoryEntry, type MemoryState, normalizeMemoryContent } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain } from 'lucide-react';
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { LoadError } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { Switch } from '~/components/ui/switch';
import { api, apiErrorMessage } from '~/lib/api-client';
import { keepFocusWhenRemoved } from '~/lib/focus-return';
import { fetchMemory, MEMORY_QUERY_KEY } from '~/lib/memory';
import { formatRelativeTime } from '~/lib/utils';

function useMemoryMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MEMORY_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

function Counted({ value, max }: { value: string; max: number }) {
  const length = normalizeMemoryContent(value).length;
  return (
    <span className={length > max ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}>
      {length}/{max}
    </span>
  );
}

function MemoryRow({
  entry,
  canEdit,
  maxChars,
}: {
  entry: MemoryEntry;
  canEdit: boolean;
  maxChars: number;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(entry.content);
  const editId = useId();
  const save = useMemoryMutation((content: string) =>
    api.patch(`/memory/${entry.id}`, { content }),
  );
  const remove = useMemoryMutation(() => api.delete(`/memory/${entry.id}`));
  const error = save.error ?? remove.error;
  const length = normalizeMemoryContent(draft).length;
  const rowRef = useRef<HTMLLIElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const editMounted = useRef(false);

  // Edit and the form replace each other, removing the control that had
  // focus: into the editor on Edit, back on Edit after Cancel, Escape or
  // Save, as Edit name does (#270).
  useLayoutEffect(() => {
    if (!editMounted.current) {
      editMounted.current = true;
      return;
    }
    if (editing) {
      const editor = editorRef.current;
      editor?.focus();
      editor?.setSelectionRange(editor.value.length, editor.value.length);
    } else if (!document.activeElement || document.activeElement === document.body) {
      editRef.current?.focus();
    }
  }, [editing]);

  const cancelEdit = () => {
    setEditing(false);
    setDraft(entry.content);
    save.reset();
  };

  // Asking, cancelling or a failed delete swaps the buttons, removing the one
  // that had focus: put focus on its counterpart rather than the body (#128).
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (document.activeElement && document.activeElement !== document.body) return;
    (confirmingDelete ? cancelRef : deleteRef).current?.focus();
  }, [confirmingDelete]);

  return (
    <li
      ref={rowRef}
      className="flex flex-col gap-2 border-b border-[var(--border-subtle)] py-4 last:border-0"
      data-testid="memory-entry"
    >
      {editing ? (
        <form
          noValidate
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (length === 0 || length > maxChars) return;
            save.mutate(draft, { onSuccess: () => setEditing(false) });
          }}
        >
          <label htmlFor={editId} className="sr-only">
            Edit memory
          </label>
          <Textarea
            ref={editorRef}
            id={editId}
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              cancelEdit();
            }}
          />
          <div className="flex items-center gap-2 text-xs">
            <Counted value={draft} max={maxChars} />
            <span className="flex-1" />
            <Button type="button" variant="ghost" size="sm" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={save.isPending || length === 0 || length > maxChars}
            >
              {save.isPending && <Spinner />}
              Save
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm text-[var(--text-primary)]">{entry.content}</p>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {entry.source === 'tool' ? 'Saved by a model' : 'Added by you'} · updated{' '}
              {formatRelativeTime(entry.updatedAt)}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            {canEdit && (
              <Button
                ref={editRef}
                variant="ghost"
                size="sm"
                aria-label={`Edit memory: ${entry.content}`}
                onClick={() => {
                  setDraft(entry.content);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
            {/* Asks first, as Delete all does: it cannot be undone (#101). */}
            {confirmingDelete ? (
              <>
                <span className="self-center text-xs text-[var(--text-secondary)]">
                  Delete this memory?
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  aria-label={`Confirm: delete memory: ${entry.content}`}
                  disabled={remove.isPending}
                  onClick={() => {
                    // Once deleted, the next memory (or the list) gets focus (#128).
                    if (rowRef.current) keepFocusWhenRemoved(rowRef.current);
                    remove.mutate(undefined, { onSettled: () => setConfirmingDelete(false) });
                  }}
                >
                  {remove.isPending && <Spinner />}
                  Delete
                </Button>
                <Button
                  ref={cancelRef}
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                ref={deleteRef}
                variant="ghost"
                size="sm"
                aria-label={`Delete memory: ${entry.content}`}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {apiErrorMessage(error, 'The memory could not be changed. Try again.')}
        </p>
      )}
    </li>
  );
}

function AddMemoryForm({ maxChars, full }: { maxChars: number; full: boolean }) {
  const [draft, setDraft] = useState('');
  const add = useMemoryMutation((content: string) => api.post('/memory', { content }));
  const length = normalizeMemoryContent(draft).length;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (length === 0 || length > maxChars || full) return;
    add.mutate(draft, { onSuccess: () => setDraft('') });
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="memory-new" className="text-sm font-medium">
        Add a memory
      </label>
      <Textarea
        id="memory-new"
        rows={2}
        value={draft}
        disabled={full}
        placeholder="For example: I teach first-year chemistry and prefer short answers."
        onChange={(event) => {
          setDraft(event.target.value);
          add.reset();
        }}
      />
      <div className="flex items-center gap-2 text-xs">
        <Counted value={draft} max={maxChars} />
        <span className="flex-1" />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={add.isPending || full || length === 0 || length > maxChars}
        >
          {add.isPending && <Spinner />}
          Add
        </Button>
      </div>
      {add.error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {apiErrorMessage(add.error, 'The memory could not be saved. Try again.')}
        </p>
      )}
    </form>
  );
}

function DeleteAll({ count }: { count: number }) {
  const [confirming, setConfirming] = useState(false);
  const removeAll = useMemoryMutation(() => api.delete('/memory'));
  const wrapperRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  // Asking and cancelling swap the buttons, removing the one that had focus:
  // focus went to the body (#250). It goes to the counterpart, as on a single
  // memory's Delete (#128).
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (document.activeElement && document.activeElement !== document.body) return;
    (confirming ? cancelRef : openRef).current?.focus();
  }, [confirming]);

  if (count === 0) return null;
  return (
    <div ref={wrapperRef} className="mt-6 flex flex-wrap items-center gap-2">
      {confirming ? (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            {/* Not "Delete all 1 memory?" (#254). */}
            {count === 1 ? 'Delete your one memory?' : `Delete all ${count} memories?`} This cannot
            be undone.
          </p>
          <Button
            variant="danger"
            size="sm"
            disabled={removeAll.isPending}
            onClick={() => {
              // With every memory gone, so are these controls: the list's
              // heading takes focus. Watched as a whole, since "Delete all…"
              // can come back for a moment before the emptied list arrives.
              if (wrapperRef.current) keepFocusWhenRemoved(wrapperRef.current);
              removeAll.mutate(undefined, { onSuccess: () => setConfirming(false) });
            }}
          >
            {removeAll.isPending && <Spinner />}
            Delete all memories
          </Button>
          <Button ref={cancelRef} variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button ref={openRef} variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          Delete all…
        </Button>
      )}
      {removeAll.error && (
        <p role="alert" className="w-full text-sm text-[var(--danger)]">
          {apiErrorMessage(removeAll.error, 'Your memories could not be deleted. Try again.')}
        </p>
      )}
    </div>
  );
}

function MemoryContent({ state }: { state: MemoryState }) {
  const toggle = useMemoryMutation((enabled: boolean) =>
    api.put<MemoryState>('/memory/settings', { enabled }),
  );
  const { enabled, available, entries, limits } = state;
  const full = entries.length >= limits.maxEntries;

  return (
    <>
      {!available && (
        <p role="note" className="mt-4 text-sm text-[var(--warning)]">
          Memory is not available to you: your administrator has not switched it on for your role or
          for this instance. You can still review, export and delete what is stored.
        </p>
      )}

      <div className="mt-6 flex items-start justify-between gap-6 rounded-xl border border-[var(--border-subtle)] px-4 py-3">
        <div>
          <label htmlFor="memory-enabled" className="text-sm font-medium">
            Use memory
          </label>
          <p id="memory-enabled-description" className="mt-1 text-sm text-[var(--text-muted)]">
            When on, your memories are included in your conversations, and models that use tools can
            save and remove them. Temporary chats never read or save memories.
          </p>
        </div>
        <Switch
          id="memory-enabled"
          aria-describedby="memory-enabled-description"
          className="mt-1 shrink-0"
          checked={enabled}
          // Switching off always works; switching on needs memory to be offered.
          disabled={toggle.isPending || (!available && !enabled)}
          onCheckedChange={(checked) => toggle.mutate(checked)}
        />
      </div>
      {toggle.error && (
        <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {apiErrorMessage(toggle.error, 'The setting could not be saved. Try again.')}
        </p>
      )}

      {available && (
        <div className="mt-8">
          <AddMemoryForm maxChars={limits.maxChars} full={full} />
          {full && (
            <p className="mt-2 text-sm text-[var(--text-muted)]">
              You have reached the limit of {limits.maxEntries} memories. Delete some to add more.
            </p>
          )}
        </div>
      )}

      <section className="mt-8" aria-labelledby="memory-list-title">
        <h2 id="memory-list-title" className="text-lg font-semibold">
          Saved memories{' '}
          <span className="text-sm font-normal text-[var(--text-muted)]">
            {entries.length} of {limits.maxEntries}
          </span>
        </h2>
        {entries.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-3 text-center">
            <Brain className="size-8 text-[var(--text-muted)]" aria-hidden="true" />
            <p className="text-sm text-[var(--text-muted)]">Nothing is remembered about you.</p>
          </div>
        ) : (
          <ul className="mt-2 flex flex-col">
            {entries.map((entry) => (
              <MemoryRow
                key={entry.id}
                entry={entry}
                canEdit={available}
                maxChars={limits.maxChars}
              />
            ))}
          </ul>
        )}
        <DeleteAll count={entries.length} />
      </section>
    </>
  );
}

/**
 * Settings → Memory: the person's own switch and every note OCI keeps about
 * them, newest first, to add, edit and delete.
 */
export function SettingsMemoryPage() {
  const memory = useQuery({ queryKey: MEMORY_QUERY_KEY, queryFn: fetchMemory });

  return (
    <div>
      <h1 className="text-2xl font-bold">Memory</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">
        Short notes about you that are included in your conversations, newest first, so you do not
        have to repeat yourself. Every note is listed here; they are included in your data export,
        and your administrator may delete notes that have not changed for a while.
      </p>

      {memory.isLoading ? (
        <div className="py-16" role="status" aria-label="Loading memory">
          <Spinner className="mx-auto size-6" />
        </div>
      ) : memory.isError || !memory.data ? (
        // Announced, with Try again, as every list's load error (#245).
        <LoadError title="Memory could not be loaded." query={memory} className="mt-8" />
      ) : (
        <MemoryContent state={memory.data} />
      )}
    </div>
  );
}
