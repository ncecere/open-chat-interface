import { Link, useParams } from '@tanstack/react-router';
import { ChevronDown, Folder, Plus } from 'lucide-react';
import { useState } from 'react';
import { CreateProjectDialog } from '~/components/projects/project-dialogs';
import { useProjects, useProjectsAvailable } from '~/hooks/use-projects';
import { cn } from '~/lib/utils';

/** The sidebar's Projects section; absent when the person's role cannot use projects. */
export function SidebarProjects() {
  const available = useProjectsAvailable();
  if (!available) return null;
  return <ProjectsSection />;
}

function ProjectsSection() {
  const { data: projects, isLoading, isError } = useProjects();
  const params = useParams({ strict: false }) as { projectId?: string };
  const [expanded, setExpanded] = useState(true);
  const [creating, setCreating] = useState(false);

  return (
    <section aria-labelledby="sidebar-projects-toggle" className="mb-4">
      <div className="flex items-center gap-1">
        <button
          id="sidebar-projects-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls="sidebar-project-list"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-6 flex-1 items-center gap-1 rounded px-2.5 pb-1 text-left text-[0.6875rem] font-semibold text-[var(--accent-bright)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown
            className={cn('size-3 transition-transform', !expanded && '-rotate-90')}
            aria-hidden="true"
          />
          Projects
        </button>
        <button
          type="button"
          aria-label="New project"
          title="New project"
          onClick={() => setCreating(true)}
          className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]"
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {expanded && (
        <div id="sidebar-project-list">
          {isLoading ? null : isError ? (
            <p className="px-2.5 py-1 text-xs text-[var(--text-muted)]">
              Projects could not be loaded.
            </p>
          ) : (projects?.length ?? 0) === 0 ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full rounded-lg px-2.5 py-2 text-left text-xs text-[var(--text-muted)] hover:bg-[var(--bg-control)] hover:text-[var(--text-primary)]"
            >
              Create a project to group conversations with shared instructions and files.
            </button>
          ) : (
            <ul className="flex flex-col gap-0.5" aria-label="Projects">
              {projects?.map((project) => {
                const active = params.projectId === project.id;
                return (
                  <li key={project.id}>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: project.id }}
                      aria-current={active ? 'page' : undefined}
                      title={project.name}
                      className={cn(
                        'flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]',
                        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-control)]',
                      )}
                    >
                      <Folder
                        className="size-3.5 shrink-0 text-[var(--text-muted)]"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 truncate">{project.name}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </section>
  );
}
