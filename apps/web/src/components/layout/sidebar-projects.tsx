import type { SidebarProject, ThreadSummary } from '@oci/shared';
import { Link, useParams } from '@tanstack/react-router';
import { ChevronRight, Folder, Plus } from 'lucide-react';
import { useState } from 'react';
import { ThreadRow } from '~/components/layout/thread-list';
import { CreateProjectDialog } from '~/components/projects/project-dialogs';
import { useAutoRetry } from '~/hooks/use-auto-retry';
import { useExpandedProjects } from '~/hooks/use-expanded-projects';
import { type OpenConversation, useOpenConversation } from '~/hooks/use-open-conversation';
import { useProjectsAvailable, useSidebarProjects } from '~/hooks/use-projects';
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
  const { data: projects, isLoading, isError, refetch } = useSidebarProjects();
  // Loads again by itself after an outage, rather than saying "could not be
  // loaded" until the page is reloaded (#233).
  useAutoRetry(isError, () => void refetch());
  const params = useParams({ strict: false }) as { projectId?: string; threadId?: string };
  const open = useOpenConversation(params.threadId);
  const { expanded, toggle } = useExpandedProjects(projects);
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
          Projects
        </h2>
        <button
          type="button"
          aria-label="New project"
          title={lock.title ?? 'New project'}
          disabled={lock.locked}
          onClick={() => setCreating(true)}
          className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] enabled:hover:bg-[var(--bg-control)] enabled:hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {isLoading ? null : isError ? (
        <p className="px-2.5 py-1 text-xs text-[var(--text-muted)]">
          Projects could not be loaded.
        </p>
      ) : (projects?.length ?? 0) === 0 ? (
        <button
          type="button"
          title={lock.title}
          disabled={lock.locked}
          onClick={() => setCreating(true)}
          className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-[var(--text-muted)] enabled:hover:bg-[var(--bg-control)] enabled:hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create a project to group conversations with shared instructions and files.
        </button>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label="Projects">
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
  const listId = `sidebar-project-${project.id}`;
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
          aria-label={`Conversations in ${project.name}`}
          title={expanded ? 'Hide conversations' : 'Show conversations'}
          onClick={onToggle}
          // 24px is the WCAG 2.2 minimum target; the row's link fills the rest.
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
            aria-hidden="true"
          />
        </button>
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          aria-current={active ? 'page' : undefined}
          title={project.name}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2.5 pl-1 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <Folder className="size-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
          <span className="min-w-0 truncate">{project.name}</span>
        </Link>
      </div>

      <div id={listId} hidden={!expanded}>
        {expanded && (
          <div className="ml-4 border-l border-[var(--border-subtle)] pl-1.5">
            {rows.length > 0 && (
              <ul aria-label={`Conversations in ${project.name}`} className="flex flex-col gap-0.5">
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
                Show all ({project.threadCount})
                <span className="sr-only"> conversations in {project.name}</span>
              </Link>
            ) : (
              rows.length === 0 && (
                <p className="px-2.5 py-1.5 text-xs text-[var(--text-muted)]">No conversations</p>
              )
            )}
          </div>
        )}
      </div>
    </li>
  );
}
