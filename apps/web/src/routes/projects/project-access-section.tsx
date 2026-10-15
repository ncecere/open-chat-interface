import type { ProjectSummary } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '~/components/admin/confirm-dialog';
import { Button } from '~/components/ui/button';
import { forgetProject, useLeaveProject, useProjectAccess } from '~/hooks/use-project-sharing';
import { ApiError } from '~/lib/api-client';
import { accessLabel, accessOf } from '~/lib/project-access';
import { useReadOnlyLock } from '~/lib/read-only';
import { Section } from './project-sections';

function people(count: number): string {
  return count === 1 ? '1 person' : `${count.toLocaleString('en-US')} people`;
}

function groups(count: number): string {
  return count === 1 ? '1 group' : `${count.toLocaleString('en-US')} groups`;
}

/** "2 people and 1 group", leaving out what is zero. Counts only: who they are is never shown. */
function sharedWith(personShares: number, groupShares: number): string {
  const parts = [personShares > 0 && people(personShares), groupShares > 0 && groups(groupShares)];
  return parts.filter(Boolean).join(' and ');
}

/**
 * What a viewer or editor sees under Settings instead of the owner's name,
 * share and delete controls: their access, who owns the project, how many it
 * is shared with (counts only), and Leave, or why they cannot leave.
 */
export function ProjectAccessSections({ project }: { project: ProjectSummary }) {
  const access = accessOf(project);
  const info = useProjectAccess(project.id);
  const ownerName = info.data?.ownerName ?? project.ownerName;
  const total = info.data ? sharedWith(info.data.personShares, info.data.groupShares) : '';

  return (
    <>
      <Section title="Your access">
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          {ownerName ? `${ownerName} owns this project` : 'Someone else owns this project'} and
          shared it with you. You are {access === 'editor' ? 'an' : 'a'} {accessLabel(access)}:{' '}
          {access === 'editor'
            ? 'you can read it, change its instructions and add or remove files.'
            : 'you can read its instructions and files and use them in your own conversations.'}{' '}
          Renaming, sharing, transferring and deleting are the owner’s.
        </p>
        {total && (
          <p className="mt-2 text-sm text-[var(--text-muted)]">It is shared with {total}.</p>
        )}
      </Section>
      {info.data && <LeaveSection project={project} canLeave={info.data.canLeave} />}
    </>
  );
}

function LeaveSection({ project, canLeave }: { project: ProjectSummary; canLeave: boolean }) {
  const [open, setOpen] = useState(false);
  const leave = useLeaveProject(project.id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lock = useReadOnlyLock();

  if (!canLeave) {
    return (
      <Section title="Leave project">
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">
          You have access through a group, so you cannot leave on your own. To stop having it, ask
          the owner or a group manager.
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
    <Section
      title="Leave project"
      description="It disappears from your lists. Your conversations in it are kept."
    >
      <Button type="button" variant="danger" locked={lock.title} onClick={() => setOpen(true)}>
        <LogOut aria-hidden="true" />
        Leave project
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Leave \u201c${project.name}\u201d?`}
        description="It disappears from your lists and you can no longer open its files or use its instructions. Your conversations in it are kept and leave the project, and files you added to it move to the owner. The owner can share it with you again."
        confirmLabel="Leave project"
        pendingLabel="Leaving…"
        errorMessage="You could not leave the project."
        onConfirm={confirm}
      />
    </Section>
  );
}
