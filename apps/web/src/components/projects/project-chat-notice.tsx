import { Link } from '@tanstack/react-router';
import { Folder } from 'lucide-react';
import { useProject } from '~/hooks/use-projects';

/** Tells the person a new chat will be created inside a project. */
export function ProjectChatNotice({ projectId }: { projectId: string }) {
  const { data: project, isError } = useProject(projectId);

  if (isError) {
    return (
      <p role="alert" className="mt-2 text-center text-sm text-[var(--warning)] md:text-left">
        That project is not available. Remove it from the address to start an ordinary chat.
      </p>
    );
  }

  return (
    <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-[var(--text-muted)] md:justify-start">
      <Folder className="size-4 shrink-0" aria-hidden="true" />
      <span>
        New chat in{' '}
        {project ? (
          <Link
            to="/projects/$projectId"
            params={{ projectId }}
            className="font-medium text-[var(--accent-bright)] underline underline-offset-2"
          >
            {project.name}
          </Link>
        ) : (
          'project'
        )}
      </span>
    </p>
  );
}
