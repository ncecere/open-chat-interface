import type { ProjectSummary } from '@oci/shared';
import { Link } from '@tanstack/react-router';
import { Folder, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { CreateProjectDialog } from '~/components/projects/project-dialogs';
import { Button } from '~/components/ui/button';
import { Spinner } from '~/components/ui/spinner';
import { UnavailableState } from '~/components/ui/unavailable-state';
import { useCurrentUser } from '~/hooks/use-current-user';
import { useProjectsOverview } from '~/hooks/use-projects';
import { apiErrorMessage } from '~/lib/api-client';
import { usePageTitle } from '~/lib/document-title';
import { accessLabel, accessOf } from '~/lib/project-access';
import { useReadOnlyLock } from '~/lib/read-only';
import { plural } from '~/lib/utils';

/**
 * Every project the person can open (v0.14): the ones they own, and below
 * them the ones other people shared with them, each with who owns it and what
 * the person may do. The sidebar lists the same two groups; this page is the
 * whole list, at any length.
 */
export function ProjectsPage() {
  const { data: me } = useCurrentUser();
  const overview = useProjectsOverview(Boolean(me?.features.projects));
  const lock = useReadOnlyLock();
  const [creating, setCreating] = useState(false);
  const unavailable = Boolean(me) && !me?.features.projects;
  usePageTitle(unavailable ? null : 'Projects');

  if (unavailable) {
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

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 md:pt-6">
      <header className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-bold leading-tight">Projects</h1>
        <Button
          type="button"
          variant="primary"
          locked={lock.title}
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" />
          New project
        </Button>
      </header>

      {!me || overview.isLoading ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Spinner /> Loading projects…
        </p>
      ) : overview.error || !overview.data ? (
        <div className="mt-8 flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
            {apiErrorMessage(overview.error, 'Projects could not be loaded.')}
          </p>
          <Button type="button" onClick={() => void overview.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <ProjectGroup title="Your projects" projects={overview.data.projects}>
            You have no projects of your own yet. Create one to group conversations under shared
            instructions and files.
          </ProjectGroup>
          <ProjectGroup title="Shared with me" projects={overview.data.shared ?? []}>
            Nothing has been shared with you yet. When someone shares a project with you, it appears
            here.
          </ProjectGroup>
        </>
      )}

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function ProjectGroup({
  title,
  projects,
  children,
}: {
  title: string;
  projects: ProjectSummary[];
  /** What an empty group says. */
  children: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="text-xl font-bold">
        {title}
      </h2>
      {projects.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--text-muted)]">{children}</p>
      ) : (
        <ul aria-label={title} className="mt-3 flex flex-col">
          {projects.map((project) => (
            <li key={project.id} className="border-b border-[var(--border-subtle)] last:border-0">
              <Link
                to="/projects/$projectId"
                params={{ projectId: project.id }}
                className="flex items-center gap-3 py-3 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <Folder className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span
                    dir="auto"
                    className="block font-medium text-[var(--text-primary)] wrap-anywhere"
                  >
                    {project.name}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {accessOf(project) === 'owner'
                      ? `${plural(project.threadCount, 'conversation')} · ${plural(project.fileCount, 'file')}`
                      : `${project.ownerName ? `${project.ownerName} · ` : ''}${accessLabel(accessOf(project))} · ${plural(project.fileCount, 'file')}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
