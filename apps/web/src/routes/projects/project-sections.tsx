import type { ProjectSummary } from '@oci/shared';
import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { deleteProjectText } from '~/components/projects/delete-project-text';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { useDeleteProject } from '~/hooks/use-projects';
import { apiErrorMessage } from '~/lib/api-client';
import { useReadOnlyLock } from '~/lib/read-only';

/** The project page's sections, apart from project.tsx to keep it under 600 lines. */

/** A titled part of a tab, laid out like the sections of the settings pages: no card. */
export function Section({
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

export function DeleteProjectSection({ project }: { project: ProjectSummary }) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteProject();
  const navigate = useNavigate();
  // Off while read-only, with the reason, as the project's other changes (#331).
  const lock = useReadOnlyLock();

  async function confirm() {
    await remove.mutateAsync({ id: project.id, name: project.name });
    setOpen(false);
    await navigate({ to: '/' });
  }

  return (
    <Section
      title="Delete project"
      description="Conversations are kept and leave the project. Its files are deleted."
    >
      <Button type="button" variant="danger" locked={lock.title} onClick={() => setOpen(true)}>
        <Trash2 aria-hidden="true" />
        Delete project
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle>Delete “{project.name}”?</DialogTitle>
            <DialogDescription>
              {deleteProjectText(project.threadCount, project.fileCount)}
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
