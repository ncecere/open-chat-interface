import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useId, useState } from 'react';
import { Button } from '~/components/ui/button';
import { ApiError, api } from '~/lib/api-client';
import { useT } from '~/lib/i18n';

/** Editing a Markdown document: saving makes a new version; nothing is overwritten. */
export function DocumentEditor({
  artifactId,
  initial,
  baseVersion,
  onDone,
}: {
  artifactId: string;
  initial: string;
  baseVersion: number;
  onDone: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const editorId = useId();
  const save = useMutation({
    mutationFn: () =>
      api.post(`/artifacts/${encodeURIComponent(artifactId)}/versions`, {
        content: draft,
        baseVersion,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] }),
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
      ]);
      onDone();
    },
  });
  const unchanged = draft === initial;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !unchanged && draft.trim()) {
      event.preventDefault();
      save.mutate();
    }
  }

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unchanged && draft.trim()) save.mutate();
      }}
    >
      <label htmlFor={editorId} className="text-sm font-medium text-[var(--text-primary)]">
        {t('artifacts.editor.label')}
      </label>
      <textarea
        id={editorId}
        dir="auto"
        // biome-ignore lint/a11y/noAutofocus: the person chose to edit; focus belongs in the editor.
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck
        className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--border-strong)] bg-[var(--bg-control)] p-3 font-mono text-sm leading-relaxed text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent-bright)]"
      />
      {save.error && (
        <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
          {save.error instanceof ApiError ? save.error.message : t('artifacts.editor.saveFailed')}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={save.isPending}>
          {t('artifacts.editor.cancel')}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={unchanged || !draft.trim() || save.isPending}
        >
          {save.isPending ? t('artifacts.editor.saving') : t('artifacts.editor.save')}
        </Button>
      </div>
    </form>
  );
}
