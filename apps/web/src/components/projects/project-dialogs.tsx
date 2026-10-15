import { PROJECT_INSTRUCTIONS_MAX_LENGTH, PROJECT_NAME_MAX_LENGTH } from '@oci/shared';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import {
  useCreateProject,
  useMoveThread,
  useProjects,
  useSharedProjects,
} from '~/hooks/use-projects';
import { apiErrorMessage } from '~/lib/api-client';
import { useT } from '~/lib/i18n';
import { isolate } from '~/lib/projects-text';
import { cn } from '~/lib/utils';

/** Names a new project and opens it. */
export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>{t('projects.create.title')}</DialogTitle>
          <DialogDescription>{t('projects.create.description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts from a blank form. */}
        <CreateProjectForm onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const create = useCreateProject();
  const navigate = useNavigate();
  const nameId = useId();
  const instructionsId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const { project } = await create.mutateAsync({ name: name.trim(), instructions });
    onDone();
    await navigate({ to: '/projects/$projectId', params: { projectId: project.id } });
  }

  return (
    <form onSubmit={(event) => void submit(event).catch(() => undefined)} noValidate>
      <div className="flex flex-col gap-4">
        <Field label={t('projects.name.label')} htmlFor={nameId}>
          <Input
            id={nameId}
            value={name}
            maxLength={PROJECT_NAME_MAX_LENGTH}
            required
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label={t('projects.create.instructionsLabel')}
          htmlFor={instructionsId}
          hint={t('projects.create.instructionsHint')}
        >
          <Textarea
            id={instructionsId}
            value={instructions}
            rows={4}
            maxLength={PROJECT_INSTRUCTIONS_MAX_LENGTH}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
      </div>
      {create.error && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
        >
          {apiErrorMessage(create.error, t('projects.create.failed'))}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('projects.common.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
          {create.isPending && <Spinner />}
          {t('projects.create.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Puts the conversation into one of the person's projects, or takes it out.
 * A radio group so the choice is one keyboard stop with arrow-key movement.
 */
export function MoveToProjectDialog({
  threadId,
  currentProjectId,
  open,
  onOpenChange,
}: {
  threadId: string;
  currentProjectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(40rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('projects.move.title')}</DialogTitle>
          <DialogDescription>{t('projects.move.description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so the choice starts from the current project. */}
        <MoveToProjectForm
          threadId={threadId}
          currentProjectId={currentProjectId}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function MoveToProjectForm({
  threadId,
  currentProjectId,
  onDone,
}: {
  threadId: string;
  currentProjectId: string | null;
  onDone: () => void;
}) {
  const t = useT();
  const projects = useProjects();
  // Any project the person can read takes their conversations (v0.14): the conversation stays theirs.
  const shared = useSharedProjects();
  const move = useMoveThread();
  const [selected, setSelected] = useState<string>(currentProjectId ?? '');
  const groupName = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = (id: string | null) =>
      (id &&
        [...(projects.data ?? []), ...(shared.data ?? [])].find((project) => project.id === id)
          ?.name) ||
      null;
    await move.mutateAsync({
      threadId,
      projectId: selected || null,
      projectName: name(selected || null),
      fromProjectName: name(currentProjectId),
    });
    onDone();
  }

  const options = [
    { value: '', label: t('projects.move.none') },
    ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name })),
    ...(shared.data ?? []).map((project) => ({
      value: project.id,
      label: project.ownerName
        ? t('projects.move.sharedBy', {
            name: isolate(project.name),
            owner: isolate(project.ownerName),
          })
        : t('projects.move.sharedWithYou', { name: isolate(project.name) }),
    })),
  ];
  const unchanged = selected === (currentProjectId ?? '');

  return (
    <form noValidate onSubmit={(event) => void submit(event).catch(() => undefined)}>
      {projects.isLoading ? (
        <p className="flex items-center gap-2 py-4 text-sm text-[var(--text-muted)]">
          <Spinner /> {t('projects.list.loading')}
        </p>
      ) : projects.error ? (
        <p role="alert" className="py-2 text-sm text-[var(--danger-on-tint)]">
          {apiErrorMessage(projects.error, t('projects.list.loadFailed'))}
        </p>
      ) : (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">{t('projects.move.legend')}</legend>
          <div className="flex flex-col gap-1">
            {options.map((option) => {
              const id = `${groupName}-${option.value || 'none'}`;
              const checked = selected === option.value;
              return (
                <label
                  key={option.value || 'none'}
                  htmlFor={id}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm',
                    checked ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
                  )}
                >
                  <input
                    id={id}
                    type="radio"
                    name={groupName}
                    value={option.value}
                    checked={checked}
                    onChange={() => setSelected(option.value)}
                    className="size-4 accent-[var(--accent)]"
                  />
                  <span className="min-w-0 truncate">{option.label}</span>
                </label>
              );
            })}
          </div>
          {(projects.data?.length ?? 0) === 0 && (
            <p className="mt-2 text-xs text-[var(--text-muted)]">{t('projects.move.noProjects')}</p>
          )}
        </fieldset>
      )}
      {move.error && (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-[var(--danger)]/15 px-3 py-2 text-xs text-[var(--danger-on-tint)]"
        >
          {apiErrorMessage(move.error, t('projects.move.failed'))}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('projects.common.cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={unchanged || move.isPending}>
          {move.isPending && <Spinner />}
          {t('projects.move.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}
