import type { ProjectSummary } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Button } from '~/components/ui/button';
import { forgetProject, useLeaveProject, useProjectAccess } from '~/hooks/use-project-sharing';
import { ApiError } from '~/lib/api-client';
import { useT } from '~/lib/i18n';
import { accessOf, sharedWithText } from '~/lib/project-access';
import { isolate } from '~/lib/projects-text';
import { useReadOnlyLock } from '~/lib/read-only';
import { Section } from './project-sections';

/**
 * What a viewer or editor sees under Settings instead of the owner's name,
 * share and delete controls: their access, who owns the project, how many it
 * is shared with (counts only), and Leave, or why they cannot leave.
 */
export function ProjectAccessSections({ project }: { project: ProjectSummary }) {
  const t = useT();
  const access = accessOf(project);
  const info = useProjectAccess(project.id);
  const ownerName = info.data?.ownerName ?? project.ownerName;
  const total = info.data ? sharedWithText(info.data.personShares, info.data.groupShares) : '';
  // The role is named in the sentence (an editor, a viewer), so each has its own.
  const explanation = ownerName
    ? t(access === 'editor' ? 'projects.access.bodyEditor' : 'projects.access.bodyViewer', {
        owner: isolate(ownerName),
      })
    : t(
        access === 'editor'
          ? 'projects.access.bodyEditorNoOwner'
          : 'projects.access.bodyViewerNoOwner',
      );

  return (
    <>
      <Section title={t('projects.access.title')}>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{explanation}</p>
        {total && (
          <p className="mt-2 text-sm text-[var(--text-muted)]">
            {t('projects.access.sharedWith', { total })}
          </p>
        )}
      </Section>
      {info.data && <LeaveSection project={project} canLeave={info.data.canLeave} />}
    </>
  );
}

function LeaveSection({ project, canLeave }: { project: ProjectSummary; canLeave: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const leave = useLeaveProject(project.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lock = useReadOnlyLock();

  if (!canLeave) {
    return (
      <Section title={t('projects.leave.title')}>
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">
          {t('projects.leave.viaGroup')}
        </p>
      </Section>
    );
  }

  async function confirm() {
    try {
      await leave.mutateAsync(project.name);
    } catch (error) {
      // Access changed under the person: through a group now, or gone.
      if (error instanceof ApiError && error.status === 404)
        void queryClient.invalidateQueries({ queryKey: ['projects', project.id], exact: true });
      throw error;
    }
    await navigate({ to: '/' });
    await forgetProject(queryClient, project.id);
  }

  return (
    <Section title={t('projects.leave.title')} description={t('projects.leave.description')}>
      <Button type="button" variant="danger" locked={lock.title} onClick={() => setOpen(true)}>
        <LogOut className="rtl:-scale-x-100" aria-hidden="true" />
        {t('projects.leave.button')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('projects.leave.dialogTitle', { name: isolate(project.name) })}
        description={t('projects.leave.dialogBody')}
        confirmLabel={t('projects.leave.button')}
        pendingLabel={t('projects.leave.pending')}
        errorMessage={t('projects.leave.failed')}
        onConfirm={confirm}
      />
    </Section>
  );
}
