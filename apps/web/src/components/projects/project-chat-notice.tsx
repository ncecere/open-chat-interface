import { Link } from '@tanstack/react-router';
import { Folder } from 'lucide-react';
import { useProject } from '~/hooks/use-projects';
import { useT } from '~/lib/i18n';

/** Stands for the project's link while the message is split around it. */
const SLOT = '\u0000';

/** Tells the person a new chat will be created inside a project. */
export function ProjectChatNotice({ projectId }: { projectId: string }) {
  const t = useT();
  const { data: project, isError } = useProject(projectId);

  if (isError) {
    return (
      <p role="alert" className="mt-2 text-center text-sm text-[var(--warning)] md:text-start">
        {t('projects.chatNotice.unavailable')}
      </p>
    );
  }

  // The sentence is one message with a place for the link, so a language can
  // put the project's name wherever its word order wants it.
  const [before = '', after = ''] = t('projects.chatNotice.inProject', { project: SLOT }).split(
    SLOT,
  );

  return (
    <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-[var(--text-muted)] md:justify-start">
      <Folder className="size-4 shrink-0" aria-hidden="true" />
      <span>
        {project ? (
          <>
            {before}
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              dir="auto"
              className="font-medium text-[var(--accent-bright)] underline underline-offset-2"
            >
              {project.name}
            </Link>
            {after}
          </>
        ) : (
          t('projects.chatNotice.generic')
        )}
      </span>
    </p>
  );
}
