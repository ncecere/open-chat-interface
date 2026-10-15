import type { SidebarProject, ThreadSummary } from '@oci/shared';
import { Link, useParams } from '@tanstack/react-router';
import { ChevronRight, Folder, LayoutList, Plus } from 'lucide-react';
import { useState } from 'react';
import { ThreadRow } from '~/components/layout/thread-list';
import { CreateProjectDialog } from '~/components/projects/project-dialogs';
import { Button } from '~/components/ui/button';
import { useAutoRetry } from '~/hooks/use-auto-retry';
import { useExpandedProjects } from '~/hooks/use-expanded-projects';
import { type OpenConversation, useOpenConversation } from '~/hooks/use-open-conversation';
import {
  useProjectsAvailable,
  useSidebarProjects,
  useSidebarSharedProjects,
} from '~/hooks/use-projects';
import { useT } from '~/lib/i18n';
import { accessLabel } from '~/lib/project-access';
import { useReadOnlyLock } from '~/lib/read-only';
import { cn } from '~/lib/utils';

/** The sidebar's Projects section; absent when the person's role cannot use projects. */
export function SidebarProjects() {
  const available = useProjectsAvailable();
  if (!available) return null;
  return <ProjectsSection />;
}

/**
 * Every project as its own disclosure: a chevron button that shows or hides
 * the project's newest conversations, next to a link to the project page.
 * Two controls rather than one, so the page and the list are each one
 * keyboard stop with a plain name.
 *
 * Projects start collapsed. Opening or closing one is remembered in this
 * browser (useExpandedProjects). The project of the conversation or project
 * page on screen opens by itself while it is on screen, without changing what
 * is remembered: moving on puts it back as it was left. Closing it by hand
 * keeps it closed for that visit.
 */
function ProjectsSection() {
  const t = useT();
  const { data: projects, isLoading, isError, refetch } = useSidebarProjects();
  // Loads again by itself after an outage, rather than saying "could not be
  // loaded" until the page is reloaded (#233).
  useAutoRetry(isError, () => void refetch());
  const params = useParams({ strict: false }) as { projectId?: string; threadId?: string };
  const open = useOpenConversation(params.threadId);
  // Projects shared with the person (v0.14) open and close like their own, in the same remembered set.
  const { data: shared } = useSidebarSharedProjects();
  const { expanded, toggle } = useExpandedProjects(projects && [...projects, ...(shared ?? [])]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Off while read-only, as the conversations' Pin, Rename and Archive are (#331).
  const lock = useReadOnlyLock();

  const routeProject = params.projectId ?? open?.thread.projectId ?? undefined;
  const autoProject = routeProject && routeProject !== dismissed ? routeProject : undefined;
  const isExpanded = (id: string) => expanded.has(id) || id === autoProject;

  function handleToggle(id: string) {
    const wasExpanded = isExpanded(id);
    if (wasExpanded && id === autoProject) setDismissed(id);
    if (!wasExpanded && id === dismissed) setDismissed(null);
    toggle(id, !wasExpanded);
  }

  return (
    <section aria-labelledby="sidebar-projects-heading" className="mb-4">
      <div className="flex items-center gap-1">
        <h2
          id="sidebar-projects-heading"
          className="min-w-0 flex-1 px-2.5 pb-1 text-[0.6875rem] font-semibold text-[var(--accent-bright)]"
        >
          {t('shell.sidebarProjects.heading')}
        </h2>
        <Link
          to="/projects"
          aria-label={t('shell.sidebarProjects.all')}
          title={t('shell.sidebarProjects.all')}
          className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] [&_svg]:size-3.5"
        >
          <LayoutList aria-hidden="true" />
        </Link>
        <Button
          type="button"
          variant="ghost"
          aria-label={t('shell.sidebarProjects.new')}
          title={t('shell.sidebarProjects.new')}
          locked={lock.title}
          onClick={() => setCreating(true)}
          className="size-6 rounded px-0 text-[var(--text-muted)] [&_svg]:size-3.5"
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>

      {isLoading ? null : isError ? (
        <p className="px-2.5 py-1 text-xs text-[var(--text-muted)]">
          {t('shell.sidebarProjects.loadFailed')}
        </p>
      ) : (projects?.length ?? 0) === 0 ? (
        <Button
          type="button"
          variant="ghost"
          locked={lock.title}
          onClick={() => setCreating(true)}
          className="h-auto w-full justify-start whitespace-normal rounded-lg px-2.5 py-2 text-start text-xs text-[var(--text-muted)]"
        >
          {t('shell.sidebarProjects.empty')}
        </Button>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label={t('shell.sidebarProjects.heading')}>
          {projects?.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              active={params.projectId === project.id}
              expanded={isExpanded(project.id)}
              onToggle={() => handleToggle(project.id)}
              openThreadId={params.threadId}
              open={open}
            />
          ))}
        </ul>
      )}

      {(shared?.length ?? 0) > 0 && (
        <div className="mt-3">
          <h3
            id="sidebar-shared-heading"
            className="px-2.5 pb-1 text-[0.6875rem] font-semibold text-[var(--accent-bright)]"
          >
            {t('shell.sidebarProjects.shared')}
          </h3>
          <ul className="flex flex-col gap-0.5" aria-label={t('shell.sidebarProjects.shared')}>
            {shared?.map((project) => (
              <ProjectItem
                key={project.id}
                project={project}
                active={params.projectId === project.id}
                expanded={isExpanded(project.id)}
                onToggle={() => handleToggle(project.id)}
                openThreadId={params.threadId}
                open={open}
              />
            ))}
          </ul>
        </div>
      )}

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </section>
  );
}

/**
 * The conversations listed under a project: its newest unpinned ones, plus
 * the open conversation when it belongs here but is older than those. It is
 * added after them rather than replacing one, so the newest stay put.
 */
export function projectRows(
  project: SidebarProject,
  open: OpenConversation | undefined,
): ThreadSummary[] {
  const rows = [...project.recentThreads];
  const thread = open?.thread;
  if (
    open &&
    thread &&
    !open.listed &&
    thread.projectId === project.id &&
    !thread.pinned &&
    !thread.archived &&
    !thread.temporary &&
    !rows.some((row) => row.id === thread.id)
  ) {
    rows.push({
      title: 'New Chat',
      pinned: false,
      archived: false,
      temporary: false,
      expiresAt: null,
      parentThreadId: null,
      branchedFromMessageId: null,
      lastMessageAt: null,
      createdAt: '',
      updatedAt: '',
      ...thread,
      projectId: project.id,
    });
  }
  return rows;
}

function ProjectItem({
  project,
  active,
  expanded,
  onToggle,
  openThreadId,
  open,
}: {
  project: SidebarProject;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  openThreadId: string | undefined;
  open: OpenConversation | undefined;
}) {
  const t = useT();
  const listId = `sidebar-project-${project.id}`;
  // Who owns a project shared with the person, and what they may do in it.
  const sharedNote =
    project.access && project.access !== 'owner'
      ? `${project.ownerName ? `${project.ownerName} · ` : ''}${accessLabel(project.access)}`
      : null;
  const rows = expanded ? projectRows(project, open) : [];
  // Pinned conversations are counted but listed in Pinned, so a project can
  // have more conversations than rows even with five or fewer.
  const more = project.threadCount > rows.length;

  return (
    <li>
      <div
        className={cn(
          'flex min-w-0 items-center rounded-lg transition-colors',
          active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={t('shell.sidebarProjects.conversationsIn', { name: project.name })}
          title={t(
            expanded
              ? 'shell.sidebarProjects.hideConversations'
              : 'shell.sidebarProjects.showConversations',
          )}
          onClick={onToggle}
          // 24px is the WCAG 2.2 minimum target; the row's link fills the rest.
          className="ms-1 flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform motion-reduce:transition-none',
              // Collapsed it points to where the text goes on (the other way in
              // Arabic); open it points down in both. `rotate`, not a flip: a
              // flipped chevron turned 90 degrees would point up.
              expanded ? 'rotate-90' : 'rtl:rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          aria-current={active ? 'page' : undefined}
          title={sharedNote ? `${project.name} · ${sharedNote}` : project.name}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pe-2.5 ps-1 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <Folder className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <span className="min-w-0">
            <span dir="auto" className="line-clamp-2 text-ellipsis [overflow-wrap:anywhere]">
              {project.name}
            </span>
            {sharedNote && (
              <span
                className={cn(
                  'line-clamp-2 text-ellipsis [overflow-wrap:anywhere] text-[0.6875rem]',
                  // The current project's row is tinted; muted text on the tint is under 4.5:1.
                  active ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]',
                )}
              >
                {sharedNote}
              </span>
            )}
          </span>
        </Link>
      </div>

      <div id={listId} hidden={!expanded}>
        {expanded && (
          <div className="ms-4 border-s border-[var(--border-subtle)] ps-1.5">
            {rows.length > 0 && (
              <ul
                aria-label={t('shell.sidebarProjects.conversationsIn', { name: project.name })}
                className="flex flex-col gap-0.5"
              >
                {rows.map((thread) => (
                  <li key={thread.id}>
                    <ThreadRow thread={thread} active={thread.id === openThreadId} />
                  </li>
                ))}
              </ul>
            )}
            {more ? (
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                search={{ tab: 'conversations' }}
                className="block rounded-lg px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]"
              >
                {t('shell.sidebarProjects.showAll', { count: project.threadCount })}
                <span className="sr-only">
                  {' '}
                  {t('shell.sidebarProjects.showAllHidden', { name: project.name })}
                </span>
              </Link>
            ) : (
              rows.length === 0 && (
                <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
                  {t('shell.sidebarProjects.noConversations')}
                </p>
              )
            )}
          </div>
        )}
      </div>
    </li>
  );
}
