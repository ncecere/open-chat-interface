import {
  MAX_FILES_PER_PROJECT,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectFile,
  type ProjectSummary,
} from '@oci/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { FileText, MessageSquarePlus, Trash2, Upload } from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
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
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import { Spinner } from '~/components/ui/spinner';
import { UnavailableState } from '~/components/ui/unavailable-state';
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
import {
  DEFAULT_PROJECT_TAB,
  type ProjectTab,
  validateProjectSearch,
} from '~/lib/chat-search-params';
import { usePageTitle } from '~/lib/document-title';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';

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

const TABS: readonly PillTab<ProjectTab>[] = [
  { id: 'conversations', label: 'Conversations' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'files', label: 'Files' },
  { id: 'settings', label: 'Settings' },
];

/** A list row, divided by a rule as on the settings pages. */
const ROW = 'flex items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-0';

/** Whether a file can be searched when the project is too large to send whole. */
function indexStatusLabel(index: ProjectFile['index'] | undefined): string {
  switch (index?.status) {
    case 'indexed':
      // Said in the row itself, not a tooltip: a long file whose end cannot be
      // searched otherwise looks fully searchable and answers come up empty.
      return index.truncated
        ? `Partly searchable · first ${index.passages.toLocaleString()} passages; the rest of the file is too long to search`
        : `Searchable · ${index.passages} ${index.passages === 1 ? 'passage' : 'passages'}`;
    case 'no-text':
      return 'No text to search';
    default:
      return 'Waiting to be indexed';
  }
}

/** A titled part of a tab, laid out like the sections of the settings pages: no card. */
function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-12 first:mt-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-xl font-bold">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * One project: its conversations, instructions, files and settings, each on
 * its own tab, and the way to start a new conversation inside it.
 */
export function ProjectPage({ projectId }: { projectId: string }) {
  const { data: me } = useCurrentUser();
  const project = useProject(me?.features.projects ? projectId : undefined);
  // Nothing started from a project is temporary; do not leave the top bar's
  // temporary-chat control highlighted here.
  const { temporary, setTemporary } = useTemporaryChat();
  useEffect(() => {
    if (temporary) setTemporary(false);
  }, [temporary, setTemporary]);
  // The project by name in the tab, rather than the app name alone (#110);
  // when it cannot be shown, the page that says so names the tab (#197).
  const unavailable =
    Boolean(me) &&
    (!me?.features.projects || (!project.isLoading && (Boolean(project.error) || !project.data)));
  usePageTitle(unavailable ? null : (project.data?.name ?? 'Project'));

  if (me && !me.features.projects) {
    return (
      <UnavailableState
        title="Projects unavailable"
        actions={
          <Button asChild>
            <Link to="/">New chat</Link>
          </Button>
        }
      >
        Projects are not available for your role.
      </UnavailableState>
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
      <UnavailableState
        alert
        title={missing ? 'Project not found' : 'Could not load project'}
        actions={
          missing ? (
            <Button asChild>
              <Link to="/">New chat</Link>
            </Button>
          ) : (
            <>
              <Button type="button" onClick={() => void project.refetch()}>
                Retry
              </Button>
              <Link to="/" className="text-sm underline">
                New chat
              </Link>
            </>
          )
        }
      >
        {missing
          ? 'This project does not exist or was deleted.'
          : apiErrorMessage(project.error, 'The project could not be loaded.')}
      </UnavailableState>
    );
  }

  return <ProjectView project={project.data} attachmentsAvailable={me.features.attachments} />;
}

function PageFrame({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 md:pt-6">{children}</div>;
}

function ProjectView({
  project,
  attachmentsAvailable,
}: {
  project: ProjectSummary;
  attachmentsAvailable: boolean;
}) {
  const navigate = useNavigate();
  // The open tab lives in the URL, so a reload or shared link opens the same one.
  const tab = validateProjectSearch(useSearch({ strict: false })).tab ?? DEFAULT_PROJECT_TAB;
  const setTab = (next: ProjectTab) =>
    void navigate({
      to: '/projects/$projectId',
      params: { projectId: project.id },
      search: { tab: next === DEFAULT_PROJECT_TAB ? undefined : next },
      replace: true,
    });

  return (
    <PageFrame>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-[var(--text-muted)]">Project</p>
          <h1 className="mt-1 break-words text-2xl font-bold leading-tight">{project.name}</h1>
        </div>
        <Button variant="primary" asChild className="shrink-0">
          <Link to="/" search={{ project: project.id }}>
            <MessageSquarePlus aria-hidden="true" />
            New chat in project
          </Link>
        </Button>
      </header>

      <div className="mt-8">
        <PillTabs
          tabs={TABS}
          active={tab}
          onChange={setTab}
          label="Project"
          controls="project-panel"
        />
      </div>

      {/* Keyed so opening another project starts its forms from its stored values. */}
      <div
        key={project.id}
        id="project-panel"
        role="tabpanel"
        aria-label={TABS.find((candidate) => candidate.id === tab)?.label}
        className="mt-10"
      >
        {tab === 'conversations' && <ProjectConversations projectId={project.id} />}
        {tab === 'instructions' && <ProjectInstructionsForm project={project} />}
        {tab === 'files' && (
          <ProjectFiles projectId={project.id} attachmentsAvailable={attachmentsAvailable} />
        )}
        {tab === 'settings' && (
          <>
            <ProjectNameForm project={project} />
            <DeleteProjectSection project={project} />
          </>
        )}
      </div>
    </PageFrame>
  );
}

/** Save state for the name and instructions forms; each sends only its own field. */
function useProjectSave(projectId: string) {
  const update = useUpdateProject(projectId);
  const [saved, setSaved] = useState(false);
  return {
    update,
    saved,
    edited: () => setSaved(false),
    save: (changes: { name?: string; instructions?: string }) => {
      setSaved(false);
      update.mutate(changes, { onSuccess: () => setSaved(true) });
    },
  };
}

function SaveRow({
  state,
  dirty,
  disabled,
}: {
  state: ReturnType<typeof useProjectSave>;
  dirty: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {state.update.error && (
        <p role="alert" className="mr-auto text-xs text-[var(--danger-on-tint)]">
          {apiErrorMessage(state.update.error, 'The project could not be saved.')}
        </p>
      )}
      <p role="status" className="text-sm text-[var(--success)]">
        {state.saved && !dirty ? 'Saved' : ''}
      </p>
      <Button type="submit" variant="primary" disabled={disabled || state.update.isPending}>
        {state.update.isPending && <Spinner />}
        Save changes
      </Button>
    </div>
  );
}

function ProjectInstructionsForm({ project }: { project: ProjectSummary }) {
  const [instructions, setInstructions] = useState(project.instructions);
  const state = useProjectSave(project.id);
  const instructionsId = useId();
  const counterId = useId();
  const dirty = instructions !== project.instructions;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty) state.save({ instructions });
  }

  return (
    <Section
      title="Instructions"
      description="Added to every conversation in this project, after the instance’s and your own instructions."
    >
      <form onSubmit={submit} className="flex flex-col gap-1.5" noValidate>
        <label htmlFor={instructionsId} className="sr-only">
          Instructions
        </label>
        <Textarea
          id={instructionsId}
          value={instructions}
          rows={10}
          maxLength={PROJECT_INSTRUCTIONS_MAX_LENGTH}
          aria-describedby={counterId}
          className="resize-y"
          placeholder="For example: Answer as a patient tutor. Use British spelling."
          onChange={(event) => {
            state.edited();
            setInstructions(event.target.value);
          }}
        />
        <p id={counterId} className="text-right text-xs text-[var(--text-muted)]">
          {instructions.length} / {PROJECT_INSTRUCTIONS_MAX_LENGTH} characters
        </p>
        <SaveRow state={state} dirty={dirty} disabled={!dirty} />
      </form>
    </Section>
  );
}

function ProjectNameForm({ project }: { project: ProjectSummary }) {
  const [name, setName] = useState(project.name);
  const state = useProjectSave(project.id);
  const nameId = useId();
  const dirty = name.trim() !== project.name;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty && name.trim()) state.save({ name: name.trim() });
  }

  return (
    <Section title="Name">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="Project name" htmlFor={nameId}>
          <Input
            id={nameId}
            value={name}
            required
            maxLength={PROJECT_NAME_MAX_LENGTH}
            autoComplete="off"
            onChange={(event) => {
              state.edited();
              setName(event.target.value);
            }}
          />
        </Field>
        <SaveRow state={state} dirty={dirty} disabled={!dirty || !name.trim()} />
      </form>
    </Section>
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
  const count = files.data?.length ?? 0;
  const full = count >= MAX_FILES_PER_PROJECT;

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    if (chosen.length > 0) upload.mutate(chosen);
  }

  return (
    <Section
      title="Files"
      description={
        <>
          Their text is given to the model in every conversation in this project. When the files are
          too large to give in full, they are searched with each message and the passages that match
          best are used instead. {count} of {MAX_FILES_PER_PROJECT} files. Files count toward your
          storage.
        </>
      }
      action={
        attachmentsAvailable && (
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
        )
      }
    >
      {!attachmentsAvailable && (
        <p className="mb-3 text-sm text-[var(--text-muted)]">
          File uploads are not available to you, so project files are not used in conversations.
        </p>
      )}
      {upload.error && (
        <p role="alert" className="mb-3 text-xs text-[var(--danger-on-tint)]">
          {apiErrorMessage(upload.error, 'A file could not be uploaded.')}
        </p>
      )}
      {remove.error && (
        <p role="alert" className="mb-3 text-xs text-[var(--danger-on-tint)]">
          {apiErrorMessage(remove.error, 'The file could not be removed.')}
        </p>
      )}
      {files.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Spinner /> Loading files…
        </p>
      ) : count === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No files yet.</p>
      ) : (
        <ul className="flex flex-col" aria-label="Project files">
          {files.data?.map((file) => (
            <li key={file.id} className={ROW}>
              <FileText className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-sm hover:underline"
                title={file.filename}
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
    </Section>
  );
}

function ProjectConversations({ projectId }: { projectId: string }) {
  const threads = useProjectThreads(projectId);

  return (
    <Section title="Conversations">
      {threads.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Spinner /> Loading conversations…
        </p>
      ) : threads.error ? (
        <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
          {apiErrorMessage(threads.error, 'Conversations could not be loaded.')}
        </p>
      ) : (threads.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No conversations yet. Start one with New chat in project, or move an existing one here
          from its conversation.
        </p>
      ) : (
        <ul className="flex flex-col" aria-label="Project conversations">
          {threads.data?.map((thread) => (
            <li key={thread.id} className="border-b border-[var(--border-subtle)] last:border-0">
              <Link
                to="/chat/$threadId"
                params={{ threadId: thread.id }}
                title={thread.title}
                className="flex items-center gap-3 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
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
    </Section>
  );
}

function DeleteProjectSection({ project }: { project: ProjectSummary }) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteProject();
  const navigate = useNavigate();

  async function confirm() {
    await remove.mutateAsync(project.id);
    setOpen(false);
    await navigate({ to: '/' });
  }

  return (
    <Section
      title="Delete project"
      description="Conversations are kept and leave the project. Its files are deleted."
    >
      <Button type="button" variant="danger" onClick={() => setOpen(true)}>
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
            <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
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
    </Section>
  );
}
