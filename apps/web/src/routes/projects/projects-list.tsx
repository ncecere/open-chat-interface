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
import { useT } from '~/lib/i18n';
import { accessLabel, accessOf } from '~/lib/project-access';
import { isolate } from '~/lib/projects-text';
import { useReadOnlyLock } from '~/lib/read-only';

/**
 * Every project the person can open (v0.14): the ones they own, and below
 * them the ones other people shared with them, each with who owns it and what
 * the person may do. The sidebar lists the same two groups; this page is the
 * whole list, at any length.
 */
export function ProjectsPage() {
  const t = useT();
  const { data: me } = useCurrentUser();
  const overview = useProjectsOverview(Boolean(me?.features.projects));
  const lock = useReadOnlyLock();
  const [creating, setCreating] = useState(false);
  const unavailable = Boolean(me) && !me?.features.projects;
  usePageTitle(unavailable ? null : t('projects.list.title'));

  if (unavailable) {
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

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 md:pt-6">
      <header className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-bold leading-tight">{t('projects.list.title')}</h1>
        <Button
          type="button"
          variant="primary"
          locked={lock.title}
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" />
          {t('projects.list.newProject')}
        </Button>
      </header>

      {!me || overview.isLoading ? (
        <p className="mt-8 flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Spinner /> {t('projects.list.loading')}
        </p>
      ) : overview.error || !overview.data ? (
        <div className="mt-8 flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-[var(--danger-on-tint)]">
            {apiErrorMessage(overview.error, t('projects.list.loadFailed'))}
          </p>
          <Button type="button" onClick={() => void overview.refetch()}>
            {t('projects.common.tryAgain')}
          </Button>
        </div>
      ) : (
        <>
          <ProjectGroup title={t('projects.list.yoursTitle')} projects={overview.data.projects}>
            {t('projects.list.yoursEmpty')}
          </ProjectGroup>
          <ProjectGroup
            title={t('projects.list.sharedTitle')}
            projects={overview.data.shared ?? []}
          >
            {t('projects.list.sharedEmpty')}
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
  const t = useT();
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
                      ? t('projects.list.ownedMeta', {
                          conversations: project.threadCount,
                          files: project.fileCount,
                        })
                      : project.ownerName
                        ? t('projects.list.sharedMeta', {
                            owner: isolate(project.ownerName),
                            access: accessLabel(accessOf(project)),
                            files: project.fileCount,
                          })
                        : t('projects.list.sharedMetaNoOwner', {
                            access: accessLabel(accessOf(project)),
                            files: project.fileCount,
                          })}
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
