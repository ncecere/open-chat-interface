import type { AdminUserProject } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { EditableFieldset } from '~/components/admin/admin-access';
import { LoadError, MutationError, SaveRow } from '~/components/admin/admin-ui';
import { DataClassSelect, useAdminDataClasses } from '~/components/admin/data-class-select';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';

const projectsKey = (userId: string) => ['admin', 'users', userId, 'projects'] as const;

const same = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join() === [...b].sort().join();

function ProjectLabelsForm({ userId, project }: { userId: string; project: AdminUserProject }) {
  const queryClient = useQueryClient();
  const classes = useAdminDataClasses();
  const saved = project.classes.map((entry) => entry.id);
  const locked = project.classes.filter((entry) => entry.locked).length;
  const [chosen, setChosen] = useState<string[]>(saved);
  const dirty = !same(chosen, saved);
  useReportUnsaved(dirty);
  const save = useMutation({
    mutationFn: () => api.put(`/admin/projects/${project.id}/data-classes`, { classIds: chosen }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: projectsKey(userId) }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'data-classes'] }),
      ]),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty) save.mutate();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 px-4 py-4">
      <h3 className="break-words text-sm font-semibold">{project.name}</h3>
      <EditableFieldset>
        <DataClassSelect
          legend={`Labels on ${project.name}`}
          classes={classes.data}
          value={chosen}
          onChange={(ids) => {
            save.reset();
            setChosen(ids);
          }}
          emptyText="No labels."
          hint={
            locked > 0
              ? `${locked} ${locked === 1 ? 'is' : 'are'} locked by an administrator.`
              : undefined
          }
        />
      </EditableFieldset>
      <MutationError error={save.error} message="The labels could not be saved." />
      <SaveRow
        hasChanges={dirty}
        isPending={save.isPending}
        errorMessage={null}
        successMessage={save.isSuccess && !dirty ? 'Labels saved and locked.' : null}
        subject={`labels on ${project.name}`}
      />
    </form>
  );
}

/**
 * A person's projects with their data classes, for an administrator to set
 * (#395). A label saved here is locked: the owner sees it with a note and only
 * an administrator removes it. Project names are shown to administrators only
 * here, and only while at least one data class exists.
 */
export function UserProjectLabels({ userId }: { userId: string }) {
  const classes = useAdminDataClasses();
  const projects = useQuery({
    queryKey: projectsKey(userId),
    queryFn: () => api.get<{ projects: AdminUserProject[] }>(`/admin/users/${userId}/projects`),
    select: (data) => data.projects,
  });
  // Nothing to set until a class is defined.
  if (!classes.data || classes.data.length === 0) return null;

  return (
    <section className="mt-8" aria-labelledby="user-project-labels">
      <h2 id="user-project-labels" className="font-semibold text-base">
        Project data classes
      </h2>
      <p className="mt-1 max-w-2xl text-[var(--text-muted)] text-sm">
        Every conversation in a project carries its labels. Labels you save here are locked: the
        owner cannot remove them. See{' '}
        <Link to="/admin/data-classes" className="underline">
          Data classes
        </Link>
        .
      </p>
      <div className="mt-3">
        {projects.isLoading ? (
          <p className="flex items-center gap-2 text-[var(--text-muted)] text-sm">
            <Spinner /> Loading projects…
          </p>
        ) : projects.isError || !projects.data ? (
          <LoadError title="Projects could not be loaded." query={projects} />
        ) : projects.data.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm">This person has no projects.</p>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)]">
            {projects.data.map((project) => (
              <ProjectLabelsForm
                key={`${project.id}:${project.classes.map((entry) => `${entry.id}${entry.locked ? '!' : ''}`).join()}`}
                userId={userId}
                project={project}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
