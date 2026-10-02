import {
  MAX_FILES_PER_PROJECT,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectFile,
  type ProjectSummary,
} from '@oci/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileText, MessageSquarePlus, Trash2, Upload } from 'lucide-react';
import { type ChangeEvent, type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
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
import { useCurrentUser } from '~/hooks/use-current-user';
import {
  useDeleteProject,
  useDeleteProjectFile,
  useProject,
  useProjectFiles,
  useProjectThreads,
  useUpdateProject,
  useUploadProjectFiles,
} from '~/hooks/use-projects';
import { ApiError, apiErrorMessage } from '~/lib/api-client';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

const SECTION =
  'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-control)]/30 p-4 sm:p-5';

/** Whether a file can be searched when the project is too large to send whole. */
function indexStatusLabel(index: ProjectFile['index'] | undefined): string {
  switch (index?.status) {
    case 'indexed':
      return `Searchable · ${index.passages} ${index.passages === 1 ? 'passage' : 'passages'}`;
    case 'no-text':
      return 'No text to search';
    default:
      return 'Waiting to be indexed';
  }
}

/**
 * One project: its name and instructions, its files, its conversations, and
 * the way to start a new conversation inside it.
 */
export function ProjectPage({ projectId }: { projectId: string }) {
  const { data: me } = useCurrentUser();
  const project = useProject(me?.features.projects ? projectId : undefined);

  if (me && !me.features.projects) {
    return (
      <PageFrame>
        <h1 className="text-2xl font-bold">Projects</h1>
        <p className="mt-3 text-sm text-[var(--text-muted)]">
          Projects are not available for your role.
        </p>
      </PageFrame>
    );
  }

  if (!me || project.isLoading) {
    return (
      <PageFrame>
        <div className="flex items-center gap-2 py-12 text-sm text-[var(--text-muted)]">
          <Spinner /> Loading project…
        </div>
      </PageFrame>
    );
  }

  if (project.error || !project.data) {
    const missing = project.error instanceof ApiError && project.error.status === 404;
    return (
      <PageFrame>
        <h1 className="text-2xl font-bold">{missing ? 'Project not found' : 'Project'}</h1>
        <p role="alert" className="mt-3 text-sm text-[var(--text-muted)]">
          {missing
            ? 'This project does not exist or was deleted.'
            : apiErrorMessage(project.error, 'The project could not be loaded.')}
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-[var(--accent-bright)] underline">
          Back to chat
        </Link>
      </PageFrame>
    );
  }

  return <ProjectView project={project.data} attachmentsAvailable={me.features.attachments} />;
}

function PageFrame({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-16 md:pt-12">{children}</div>;
}

function ProjectView({
  project,
  attachmentsAvailable,
}: {
  project: ProjectSummary;
  attachmentsAvailable: boolean;
}) {
  return (
    <PageFrame>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--accent-bright)]">Project</p>
          <h1 className="mt-1 break-words text-2xl font-bold leading-tight">{project.name}</h1>
        </div>
        <Button variant="primary" asChild className="shrink-0">
          <Link to="/" search={{ project: project.id }}>
            <MessageSquarePlus aria-hidden="true" />
            New chat in project
          </Link>
        </Button>
      </header>

      <div className="mt-8 flex flex-col gap-6">
        {/* Keyed so opening another project starts from its stored values. */}
        <ProjectDetailsForm key={project.id} project={project} />
        <ProjectFiles projectId={project.id} attachmentsAvailable={attachmentsAvailable} />
        <ProjectConversations projectId={project.id} />
        <DeleteProjectSection project={project} />
      </div>
    </PageFrame>
  );
}

function ProjectDetailsForm({ project }: { project: ProjectSummary }) {
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.instructions);
  const update = useUpdateProject(project.id);
  const [saved, setSaved] = useState(false);
  const nameId = useId();
  const instructionsId = useId();
  const counterId = useId();

  const changes = {
    ...(name.trim() !== project.name ? { name: name.trim() } : {}),
    ...(instructions !== project.instructions ? { instructions } : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || !name.trim()) return;
    setSaved(false);
    update.mutate(changes, { onSuccess: () => setSaved(true) });
  }

  return (
    <section aria-labelledby={`${nameId}-heading`} className={SECTION}>
      <h2 id={`${nameId}-heading`} className="text-base font-semibold">
        Name and instructions
      </h2>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-4" noValidate>
        <Field label="Project name" htmlFor={nameId}>
          <Input
            id={nameId}
            value={name}
            required
            maxLength={PROJECT_NAME_MAX_LENGTH}
            autoComplete="off"
            onChange={(event) => {
              setSaved(false);
              setName(event.target.value);
            }}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={instructionsId} className="text-sm font-medium">
            Instructions
          </label>
          <p className="text-xs text-[var(--text-muted)]">
            Added to every conversation in this project, after the instance’s and your own
            instructions.
          </p>
          <Textarea
            id={instructionsId}
            value={instructions}
            rows={8}
            maxLength={PROJECT_INSTRUCTIONS_MAX_LENGTH}
            aria-describedby={counterId}
            className="resize-y"
            placeholder="For example: Answer as a patient tutor. Use British spelling."
            onChange={(event) => {
              setSaved(false);
              setInstructions(event.target.value);
            }}
          />
          <p id={counterId} className="text-right text-xs text-[var(--text-muted)]">
            {instructions.length} / {PROJECT_INSTRUCTIONS_MAX_LENGTH} characters
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {update.error && (
            <p role="alert" className="mr-auto text-xs text-[var(--danger-foreground)]">
              {apiErrorMessage(update.error, 'The project could not be saved.')}
            </p>
          )}
          <p role="status" className="text-sm text-[var(--success)]">
            {saved && !dirty ? 'Saved' : ''}
          </p>
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || !name.trim() || update.isPending}
          >
            {update.isPending && <Spinner />}
            Save changes
          </Button>
        </div>
      </form>
    </section>
  );
}

function ProjectFiles({
  projectId,
  attachmentsAvailable,
}: {
  projectId: string;
  attachmentsAvailable: boolean;
}) {
  const files = useProjectFiles(projectId);
  const upload = useUploadProjectFiles(projectId);
  const remove = useDeleteProjectFile(projectId);
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const count = files.data?.length ?? 0;
  const full = count >= MAX_FILES_PER_PROJECT;

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    if (chosen.length > 0) upload.mutate(chosen);
  }

  return (
    <section aria-labelledby={headingId} className={SECTION}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-base font-semibold">
            Files
          </h2>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Their text is given to the model in every conversation in this project. When the files
            are too large to give in full, they are searched with each message and the passages that
            match best are used instead. {count} of {MAX_FILES_PER_PROJECT} files. Files count
            toward your storage.
          </p>
        </div>
        {attachmentsAvailable && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={choose}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={full || upload.isPending}
              onClick={() => inputRef.current?.click()}
            >
              {upload.isPending ? <Spinner /> : <Upload aria-hidden="true" />}
              Upload files
            </Button>
          </>
        )}
      </div>
      {!attachmentsAvailable && (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          File uploads are not available to you, so project files are not used in conversations.
        </p>
      )}
      {upload.error && (
        <p role="alert" className="mt-3 text-xs text-[var(--danger-foreground)]">
          {apiErrorMessage(upload.error, 'A file could not be uploaded.')}
        </p>
      )}
      {remove.error && (
        <p role="alert" className="mt-3 text-xs text-[var(--danger-foreground)]">
          {apiErrorMessage(remove.error, 'The file could not be removed.')}
        </p>
      )}
      {files.isLoading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Spinner /> Loading files…
        </p>
      ) : count === 0 ? (
        <p className="mt-4 text-sm text-[var(--text-muted)]">No files yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-1" aria-label="Project files">
          {files.data?.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-[var(--bg-control)]"
            >
              <FileText className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm hover:underline"
              >
                {file.filename}
              </a>
              <span
                className="shrink-0 text-xs text-[var(--text-muted)]"
                data-index-status={file.index?.status ?? 'pending'}
              >
                {indexStatusLabel(file.index)}
              </span>
              <span className="hidden shrink-0 text-xs text-[var(--text-muted)] sm:inline">
                {formatBytes(file.sizeBytes)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${file.filename}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(file.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectConversations({ projectId }: { projectId: string }) {
  const threads = useProjectThreads(projectId);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className={SECTION}>
      <h2 id={headingId} className="text-base font-semibold">
        Conversations
      </h2>
      {threads.isLoading ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Spinner /> Loading conversations…
        </p>
      ) : threads.error ? (
        <p role="alert" className="mt-4 text-sm text-[var(--danger-foreground)]">
          {apiErrorMessage(threads.error, 'Conversations could not be loaded.')}
        </p>
      ) : (threads.data?.length ?? 0) === 0 ? (
        <p className="mt-4 text-sm text-[var(--text-muted)]">
          No conversations yet. Start one with New chat in project, or move an existing one here
          from its conversation.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-0.5" aria-label="Project conversations">
          {threads.data?.map((thread) => (
            <li key={thread.id}>
              <Link
                to="/chat/$threadId"
                params={{ threadId: thread.id }}
                className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-[var(--bg-control)]"
              >
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 text-xs text-[var(--text-muted)]">
                  {formatDate(thread.lastMessageAt ?? thread.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeleteProjectSection({ project }: { project: ProjectSummary }) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteProject();
  const navigate = useNavigate();
  const headingId = useId();

  async function confirm() {
    await remove.mutateAsync(project.id);
    setOpen(false);
    await navigate({ to: '/' });
  }

  return (
    <section aria-labelledby={headingId} className={SECTION}>
      <h2 id={headingId} className="text-base font-semibold">
        Delete project
      </h2>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Conversations are kept and leave the project. Its files are deleted.
      </p>
      <Button type="button" variant="danger" className="mt-4" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden="true" />
        Delete project
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle>Delete “{project.name}”?</DialogTitle>
            <DialogDescription>
              {project.threadCount === 1
                ? 'Its conversation is kept and leaves the project.'
                : `Its ${project.threadCount} conversations are kept and leave the project.`}{' '}
              {project.fileCount === 1
                ? 'Its file is deleted permanently.'
                : `Its ${project.fileCount} files are deleted permanently.`}
            </DialogDescription>
          </DialogHeader>
          {remove.error && (
            <p role="alert" className="text-xs text-[var(--danger-foreground)]">
              {apiErrorMessage(remove.error, 'The project could not be deleted.')}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={remove.isPending}
              onClick={() => void confirm().catch(() => undefined)}
            >
              {remove.isPending && <Spinner />}
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
