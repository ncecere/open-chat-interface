import {
  MAX_FILES_PER_PROJECT,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectAccessLevel,
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
import { ShareProjectButton } from '~/components/projects/share-dialog';
import { TransferProjectSection } from '~/components/projects/transfer-dialog';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { type PillTab, PillTabs } from '~/components/ui/pill-tabs';
import { Spinner } from '~/components/ui/spinner';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { useCurrentUser } from '~/hooks/use-current-user';
import {
  useDeleteProjectFile,
  useProject,
  useProjectFiles,
  useProjectThreads,
  useRefreshOnAccessLoss,
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
import { formatDate, formatFileSize, type Translate, useT } from '~/lib/i18n';
import { accessLabel, accessOf, projectControls } from '~/lib/project-access';
import { isolate } from '~/lib/projects-text';
import { useReadOnlyLock } from '~/lib/read-only';
import { useTemporaryChat } from '~/providers/temporary-chat-provider';
import { ProjectAccessSections } from './project-access-section';
import { ProjectLabelsSection } from './project-labels';
import { DeleteProjectSection, Section } from './project-sections';

/** The tabs, named in the person's language; the ids are what the address carries. */
function projectTabs(t: Translate): readonly PillTab<ProjectTab>[] {
  return [
    { id: 'conversations', label: t('projects.page.tabConversations') },
    { id: 'instructions', label: t('projects.page.tabInstructions') },
    { id: 'files', label: t('projects.page.tabFiles') },
    { id: 'settings', label: t('projects.page.tabSettings') },
  ];
}

/** A list row, divided by a rule as on the settings pages. */
const ROW = 'flex items-center gap-3 border-b border-[var(--border-subtle)] py-3 last:border-0';

/** Whether a file can be searched when the project is too large to send whole. */
function indexStatusLabel(index: ProjectFile['index'] | undefined, t: Translate): string {
  switch (index?.status) {
    case 'indexed':
      // Said in the row itself, not a tooltip: a long file whose end cannot be
      // searched otherwise looks fully searchable and answers come up empty.
      return index.truncated
        ? t('projects.files.indexPartial', { passages: index.passages })
        : t('projects.files.indexed', { passages: index.passages });
    case 'no-text':
      return t('projects.files.indexNoText');
    default:
      return t('projects.files.indexWaiting');
  }
}

/**
 * One project: its conversations, instructions, files and settings, each on
 * its own tab, and the way to start a new conversation inside it.
 */
export function ProjectPage({ projectId }: { projectId: string }) {
  const t = useT();
  const { data: me } = useCurrentUser();
  const project = useProject(me?.features.projects ? projectId : undefined);
  // A project that was on screen and now answers 404 lost its access mid-session (v0.14).
  const opened = useRef<string | null>(null);
  if (project.data) opened.current = projectId;
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
  usePageTitle(unavailable ? null : (project.data?.name ?? t('projects.page.documentTitle')));

  if (me && !me.features.projects) {
    return (
      <UnavailableState
        title={t('projects.common.unavailableTitle')}
        actions={
          <Button asChild>
            <Link to="/">{t('projects.common.newChat')}</Link>
          </Button>
        }
      >
        {t('projects.common.unavailableBody')}
      </UnavailableState>
    );
  }

  if (!me || project.isLoading) {
    return (
      <PageFrame>
        <div className="flex items-center gap-2 py-12 text-sm text-[var(--text-muted)]">
          <Spinner /> {t('projects.page.loading')}
        </div>
      </PageFrame>
    );
  }

  if (project.error || !project.data) {
    const missing = project.error instanceof ApiError && project.error.status === 404;
    // 404 is also what a project the person never had answers, so only a project
    // that was open a moment ago can be called "no longer yours".
    const lost = missing && opened.current === projectId;
    return (
      <UnavailableState
        alert
        title={
          lost
            ? t('projects.page.lostTitle')
            : missing
              ? t('projects.page.missingTitle')
              : t('projects.page.loadErrorTitle')
        }
        actions={
          missing ? (
            <Button asChild>
              <Link to="/">{t('projects.common.newChat')}</Link>
            </Button>
          ) : (
            <>
              <Button type="button" onClick={() => void project.refetch()}>
                {t('projects.page.retry')}
              </Button>
              <Link to="/" className="text-sm underline">
                {t('projects.common.newChat')}
              </Link>
            </>
          )
        }
      >
        {lost
          ? t('projects.page.lostBody')
          : missing
            ? t('projects.page.missingBody')
            : apiErrorMessage(project.error, t('projects.page.loadFailed'))}
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
  const t = useT();
  const navigate = useNavigate();
  const tabs = projectTabs(t);
  const access = accessOf(project);
  const controls = projectControls(access);
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
          <p className="text-sm text-[var(--text-muted)]">{t('projects.page.eyebrow')}</p>
          <h1 dir="auto" className="mt-1 break-words text-2xl font-bold leading-tight">
            {project.name}
          </h1>
          {access !== 'owner' && (
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {project.ownerName
                ? t('projects.page.sharedBy', {
                    owner: isolate(project.ownerName),
                    access: accessLabel(access),
                  })
                : t('projects.page.sharedWithYou', { access: accessLabel(access) })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {controls.share && <ShareProjectButton project={project} />}
          <Button variant="primary" asChild>
            <Link to="/" search={{ project: project.id }}>
              <MessageSquarePlus aria-hidden="true" />
              {t('projects.page.newChatInProject')}
            </Link>
          </Button>
        </div>
      </header>

      <div className="mt-8">
        <PillTabs
          tabs={tabs}
          active={tab}
          onChange={setTab}
          label={t('projects.page.tabsLabel')}
          controls="project-panel"
        />
      </div>

      {/* Keyed so opening another project starts its forms from its stored values. */}
      <div
        key={project.id}
        id="project-panel"
        role="tabpanel"
        aria-label={tabs.find((candidate) => candidate.id === tab)?.label}
        className="mt-10"
      >
        {tab === 'conversations' && (
          <ProjectConversations projectId={project.id} shared={access !== 'owner'} />
        )}
        {tab === 'instructions' && (
          <ProjectInstructionsForm project={project} canEdit={controls.editInstructions} />
        )}
        {tab === 'files' && (
          <ProjectFiles
            projectId={project.id}
            attachmentsAvailable={attachmentsAvailable}
            access={access}
          />
        )}
        {tab === 'settings' &&
          (access === 'owner' ? (
            <>
              <ProjectNameForm project={project} />
              <ProjectLabelsSection projectId={project.id} />
              <TransferProjectSection project={project} />
              <DeleteProjectSection project={project} />
            </>
          ) : (
            <ProjectAccessSections project={project} />
          ))}
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
  // The project's changes are refused while read-only: off, with the reason (#331).
  const t = useT();
  const lock = useReadOnlyLock();
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {state.update.error && (
        <p role="alert" className="me-auto text-xs text-[var(--danger-on-tint)]">
          {apiErrorMessage(state.update.error, t('projects.page.saveFailed'))}
        </p>
      )}
      <p role="status" className="text-sm text-[var(--success)]">
        {state.saved && !dirty ? t('projects.page.saved') : ''}
      </p>
      <Button
        type="submit"
        variant="primary"
        locked={lock.title}
        disabled={disabled || state.update.isPending}
      >
        {state.update.isPending && <Spinner />}
        {t('projects.page.saveChanges')}
      </Button>
    </div>
  );
}

function ProjectInstructionsForm({
  project,
  canEdit,
}: {
  project: ProjectSummary;
  canEdit: boolean;
}) {
  const t = useT();
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
      title={t('projects.page.tabInstructions')}
      description={
        canEdit
          ? t('projects.instructions.descriptionEditable')
          : t('projects.instructions.descriptionReadOnly')
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-1.5" noValidate>
        <label htmlFor={instructionsId} className="sr-only">
          {t('projects.page.tabInstructions')}
        </label>
        <Textarea
          id={instructionsId}
          value={instructions}
          rows={10}
          readOnly={!canEdit}
          maxLength={PROJECT_INSTRUCTIONS_MAX_LENGTH}
          aria-describedby={counterId}
          className="resize-y"
          placeholder={canEdit ? t('projects.instructions.placeholder') : undefined}
          onChange={(event) => {
            state.edited();
            setInstructions(event.target.value);
          }}
        />
        <p id={counterId} className="text-end text-xs text-[var(--text-muted)]">
          {t('projects.instructions.counter', {
            count: instructions.length,
            max: PROJECT_INSTRUCTIONS_MAX_LENGTH,
          })}
        </p>
        {canEdit && <SaveRow state={state} dirty={dirty} disabled={!dirty} />}
      </form>
    </Section>
  );
}

function ProjectNameForm({ project }: { project: ProjectSummary }) {
  const t = useT();
  const [name, setName] = useState(project.name);
  const state = useProjectSave(project.id);
  const nameId = useId();
  const dirty = name.trim() !== project.name;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty && name.trim()) state.save({ name: name.trim() });
  }

  return (
    <Section title={t('projects.name.title')}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label={t('projects.name.label')} htmlFor={nameId}>
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
  access,
}: {
  projectId: string;
  attachmentsAvailable: boolean;
  access: ProjectAccessLevel;
}) {
  const t = useT();
  const canManage = projectControls(access).manageFiles;
  const files = useProjectFiles(projectId);
  useRefreshOnAccessLoss(projectId, files.error);
  const upload = useUploadProjectFiles(projectId);
  const remove = useDeleteProjectFile(projectId);
  const lock = useReadOnlyLock();
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
      title={t('projects.page.tabFiles')}
      description={t(
        access === 'owner'
          ? 'projects.files.descriptionOwner'
          : access === 'editor'
            ? 'projects.files.descriptionEditor'
            : 'projects.files.descriptionViewer',
        { count, max: MAX_FILES_PER_PROJECT },
      )}
      action={
        canManage &&
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
              locked={lock.title}
              disabled={full || upload.isPending}
              onClick={() => inputRef.current?.click()}
            >
              {upload.isPending ? <Spinner /> : <Upload aria-hidden="true" />}
              {t('projects.files.upload')}
            </Button>
          </>
        )
      }
    >
      {canManage && !attachmentsAvailable && (
        <p className="mb-3 text-sm text-[var(--text-muted)]">
          {t('projects.files.uploadsUnavailable')}
        </p>
      )}
      {upload.error && (
        <p role="alert" className="mb-3 text-xs text-[var(--danger-on-tint)]">
          {apiErrorMessage(upload.error, t('projects.files.uploadFailed'))}
        </p>
      )}
      {remove.error && (
        <p role="alert" className="mb-3 text-xs text-[var(--danger-on-tint)]">
          {apiErrorMessage(remove.error, t('projects.files.removeFailed'))}
        </p>
      )}
      {files.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Spinner /> {t('projects.files.loading')}
        </p>
      ) : count === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t('projects.files.empty')}</p>
      ) : (
        <ul className="flex flex-col" aria-label={t('projects.files.listLabel')}>
          {files.data?.map((file) => (
            <li key={file.id} className={ROW}>
              <FileText className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <a
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                  // Wrapped, not cut: a tooltip is no use on touch (#244).
                  dir="auto"
                  className="text-sm wrap-anywhere hover:underline"
                >
                  {file.filename}
                </a>
                {addedByText(file, t) && (
                  <p className="text-xs text-[var(--text-muted)]">{addedByText(file, t)}</p>
                )}
              </div>
              <span
                className="shrink-0 text-xs text-[var(--text-muted)]"
                data-index-status={file.index?.status ?? 'pending'}
              >
                {indexStatusLabel(file.index, t)}
              </span>
              <span className="hidden shrink-0 text-xs text-[var(--text-muted)] sm:inline">
                {formatFileSize(file.sizeBytes)}
              </span>
              {canManage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('projects.files.remove', { name: isolate(file.filename) })}
                  locked={lock.title}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(file.id)}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Who added a file, as the API says (a display name, never an email); nothing from an older API. */
function addedByText(file: ProjectFile, t: Translate): string | null {
  if (file.addedByMe) return t('projects.files.addedByYou');
  if (file.addedBy === undefined) return null;
  return file.addedBy === null
    ? t('projects.files.addedByDeleted')
    : t('projects.files.addedBy', { name: isolate(file.addedBy) });
}

function ProjectConversations({ projectId, shared }: { projectId: string; shared: boolean }) {
  const t = useT();
  const threads = useProjectThreads(projectId);
  useRefreshOnAccessLoss(projectId, threads.error);

  return (
    <Section
      title={t('projects.page.tabConversations')}
      description={shared ? t('projects.conversations.sharedNote') : undefined}
    >
      {threads.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Spinner /> {t('projects.conversations.loading')}
        </p>
      ) : threads.error ? (
        <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
          {apiErrorMessage(threads.error, t('projects.conversations.loadFailed'))}
        </p>
      ) : (threads.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t('projects.conversations.empty')}</p>
      ) : (
        <ul className="flex flex-col" aria-label={t('projects.conversations.listLabel')}>
          {threads.data?.map((thread) => (
            <li key={thread.id} className="border-b border-[var(--border-subtle)] last:border-0">
              <Link
                to="/chat/$threadId"
                params={{ threadId: thread.id }}
                title={thread.title}
                className="flex items-center gap-3 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <span dir="auto" className="min-w-0 flex-1 truncate">
                  {thread.title}
                </span>
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
