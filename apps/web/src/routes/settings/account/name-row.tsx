import { PROFILE_NAME_MAX_LENGTH } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { authClient } from '~/lib/auth-client';
import { useClearReadOnlyRefusal } from '~/lib/read-only-refusals';
import { type AuthResult, authErrorMessage } from './account-helpers';

export function NameRow({ name, editable }: { name: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  // A read-only refusal goes once changes are accepted again (#308).
  useClearReadOnlyRefusal(error, () => setError(null));
  const [saved, setSaved] = useState(false);
  const trimmed = draft.trim();
  const inputRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  // Opening and closing the editor swap Edit for the form, removing the
  // control that had focus, which fell to the body (#270). Opening puts the
  // cursor in the field; Save and Cancel return focus to Edit name, as the
  // sidebar rename does. Not on first render, and not if focus has moved on.
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (editing) {
      inputRef.current?.focus();
      return;
    }
    if (!document.activeElement || document.activeElement === document.body) {
      editRef.current?.focus();
    }
  }, [editing]);

  function cancel() {
    setEditing(false);
    setError(null);
  }

  const save = useMutation({
    mutationFn: async (next: string) => {
      const result = (await authClient.updateUser({ name: next })) as AuthResult;
      const message = authErrorMessage(result, 'Your name could not be saved. Try again.');
      if (message) throw new Error(message);
    },
    onSuccess: async () => {
      setEditing(false);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (failure) => setError(failure.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed.length < 1 || trimmed.length > PROFILE_NAME_MAX_LENGTH) {
      setError(`Your name must be 1 to ${PROFILE_NAME_MAX_LENGTH} characters.`);
      return;
    }
    setError(null);
    save.mutate(trimmed);
  }

  if (editing) {
    return (
      <form onSubmit={submit} className="border-b border-[var(--border-subtle)] pb-3">
        <label htmlFor={inputId} className="text-[var(--text-muted)]">
          Name
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input
            ref={inputRef}
            id={inputId}
            value={draft}
            maxLength={PROFILE_NAME_MAX_LENGTH}
            autoComplete="name"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !save.isPending) cancel();
            }}
          />
          <div className="flex gap-2">
            <Button type="submit" variant="accent" size="sm" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
        {error && (
          <p id={`${inputId}-error`} role="alert" className="mt-2 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
      <span className="text-[var(--text-muted)]">Name</span>
      <span className="flex min-w-0 items-center gap-2">
        {saved && (
          <span role="status" className="text-xs text-[var(--success)]">
            Saved
          </span>
        )}
        <span className="truncate text-[var(--text-primary)]">{name}</span>
        {editable ? (
          <Button
            ref={editRef}
            variant="ghost"
            size="sm"
            aria-label="Edit name"
            onClick={() => {
              setDraft(name);
              setSaved(false);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        ) : null}
      </span>
    </div>
  );
}
