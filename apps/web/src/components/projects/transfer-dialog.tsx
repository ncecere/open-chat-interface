import type { ProjectShare } from '@oci/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ChoiceRow } from '~/components/projects/choice-row';
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
import { useProjectShares, useTransferProject } from '~/hooks/use-project-sharing';
import { useT } from '~/lib/i18n';
import { describeShareError } from '~/lib/project-access';
import { isolate } from '~/lib/projects-text';
import { useReadOnlyLock } from '~/lib/read-only';

type PersonShare = ProjectShare & { subject: { type: 'person' } };

/** Only a person with a direct editor share can become the owner; a group's editors cannot. */
function candidates(shares: ProjectShare[] | undefined): PersonShare[] {
  return (shares ?? []).filter(
    (share): share is PersonShare =>
      share.subject.type === 'person' && share.permission === 'editor',
  );
}

/**
 * Transfer ownership, in the project's Settings: pick someone who already
 * holds a direct editor share, read what changes, confirm. The new owner
 * gets every owner's control; the old one stays on as an editor, and files
 * and conversations stay where they are.
 */
export function TransferProjectSection({ project }: { project: { id: string; name: string } }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lock = useReadOnlyLock();
  return (
    <section aria-labelledby="transfer-project-heading" className="mt-12">
      <h2 id="transfer-project-heading" className="text-xl font-bold">
        {t('projects.transfer.title')}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
        {t('projects.transfer.description')}
      </p>
      <div className="mt-4">
        <Button type="button" variant="secondary" locked={lock.title} onClick={() => setOpen(true)}>
          {t('projects.transfer.open')}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(40rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] overflow-y-auto">
          {/* Mounted only while open: the list is read again each time, and nobody starts chosen. */}
          <TransferBody project={project} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TransferBody({
  project,
  onDone,
}: {
  project: { id: string; name: string };
  onDone: () => void;
}) {
  const t = useT();
  const shares = useProjectShares(project.id);
  const transfer = useTransferProject(project.id);
  const lock = useReadOnlyLock();
  const group = useId();
  const [chosen, setChosen] = useState('');
  const eligible = candidates(shares.data);
  const target = eligible.find((share) => share.id === chosen);

  async function confirm() {
    if (!target) return;
    try {
      await transfer.mutateAsync(target.subject.email);
    } catch {
      return;
    }
    toast.success(
      t('projects.transfer.toast', {
        project: isolate(project.name),
        name: isolate(target.subject.name),
      }),
      {
        id: `project-transferred-${project.id}`,
        description: t('projects.transfer.toastDetail'),
      },
    );
    onDone();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('projects.transfer.dialogTitle', { name: isolate(project.name) })}
        </DialogTitle>
        <DialogDescription>
          {target
            ? t('projects.transfer.confirm', {
                project: isolate(project.name),
                name: isolate(target.subject.name),
              })
            : t('projects.transfer.choose')}
        </DialogDescription>
      </DialogHeader>

      {shares.isLoading ? (
        <p className="flex items-center gap-2 py-2 text-sm text-[var(--text-muted)]">
          <Spinner /> {t('sharing.list.loading')}
        </p>
      ) : shares.error ? (
        <p role="alert" className="py-2 text-sm text-[var(--danger-on-tint)]">
          {describeShareError(shares.error, t('projects.transfer.loadFailed'), 'transfer')}
        </p>
      ) : eligible.length === 0 ? (
        <p className="py-2 text-sm text-[var(--text-muted)]">
          {t('projects.transfer.noCandidates')}
        </p>
      ) : (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">{t('projects.transfer.legend')}</legend>
          <div className="flex flex-col">
            {eligible.map((share) => (
              <ChoiceRow
                key={share.id}
                name={group}
                value={share.id}
                checked={chosen === share.id}
                onChange={setChosen}
                label={t('projects.transfer.candidate', {
                  name: isolate(share.subject.name),
                  email: share.subject.email,
                })}
              />
            ))}
          </div>
        </fieldset>
      )}

      {transfer.error && (
        <p role="alert" className="mt-3 text-xs text-[var(--danger-on-tint)]">
          {describeShareError(transfer.error, t('projects.transfer.failed'), 'transfer')}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('projects.common.cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          locked={lock.title}
          disabled={!target || transfer.isPending}
          onClick={() => void confirm()}
        >
          {transfer.isPending && <Spinner />}
          {t('projects.transfer.submit')}
        </Button>
      </DialogFooter>
    </>
  );
}
