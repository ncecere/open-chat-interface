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
import { useProjectAccess } from '~/hooks/use-project-sharing';
import { useDeleteProject } from '~/hooks/use-projects';
import { apiErrorMessage } from '~/lib/api-client';
import { useT } from '~/lib/i18n';
import { sharedWithText } from '~/lib/project-access';
import { isolate } from '~/lib/projects-text';
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
  const t = useT();
  const [open, setOpen] = useState(false);
  const remove = useDeleteProject();
  // Who loses access (counts only), read when the dialog opens (v0.14).
  const access = useProjectAccess(project.id, open);
  const shares = access.data
    ? sharedWithText(access.data.personShares, access.data.groupShares)
    : '';
  const navigate = useNavigate();
  // Off while read-only, with the reason, as the project's other changes (#331).
  const lock = useReadOnlyLock();

  async function confirm() {
    await remove.mutateAsync({ id: project.id, name: project.name });
    setOpen(false);
    await navigate({ to: '/' });
  }

  return (
    <Section title={t('projects.delete.title')} description={t('projects.delete.description')}>
      <Button type="button" variant="danger" locked={lock.title} onClick={() => setOpen(true)}>
        <Trash2 aria-hidden="true" />
        {t('projects.delete.button')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle>
              {t('projects.delete.dialogTitle', { name: isolate(project.name) })}
            </DialogTitle>
            <DialogDescription>
              {deleteProjectText(project.threadCount, project.fileCount)}
              {shares && ` ${t('projects.delete.sharedNote', { shares })}`}
            </DialogDescription>
          </DialogHeader>
          {remove.error && (
            <p role="alert" className="text-xs text-[var(--danger-on-tint)]">
              {apiErrorMessage(remove.error, t('projects.delete.failed'))}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('projects.common.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={remove.isPending}
              onClick={() => void confirm().catch(() => undefined)}
            >
              {remove.isPending && <Spinner />}
              {t('projects.delete.button')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
