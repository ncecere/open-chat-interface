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
import { describeShareError } from '~/lib/project-access';
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
  const [open, setOpen] = useState(false);
  const lock = useReadOnlyLock();
  return (
    <section aria-labelledby="transfer-project-heading" className="mt-12">
      <h2 id="transfer-project-heading" className="text-xl font-bold">
        Transfer ownership
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
        Give the project to someone who already has editor access. You stay on it as an editor.
      </p>
      <div className="mt-4">
        <Button type="button" variant="secondary" locked={lock.title} onClick={() => setOpen(true)}>
          Transfer project…
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
    toast.success(`“${project.name}” now belongs to ${target.subject.name}.`, {
      id: `project-transferred-${project.id}`,
      description: 'You are now an editor.',
    });
    onDone();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Transfer “{project.name}”</DialogTitle>
        <DialogDescription>
          {target
            ? `Transfer “${project.name}” to ${target.subject.name}? ${target.subject.name} becomes the owner and can rename, delete, share and transfer the project. You stay on the project as an editor. Files and conversations stay where they are.`
            : 'Choose who becomes the owner.'}
        </DialogDescription>
      </DialogHeader>

      {shares.isLoading ? (
        <p className="flex items-center gap-2 py-2 text-sm text-[var(--text-muted)]">
          <Spinner /> Loading…
        </p>
      ) : shares.error ? (
        <p role="alert" className="py-2 text-sm text-[var(--danger-on-tint)]">
          {describeShareError(shares.error, 'The people with access could not be loaded.')}
        </p>
      ) : eligible.length === 0 ? (
        <p className="py-2 text-sm text-[var(--text-muted)]">
          Only a person you have shared the project with directly as an editor can become its owner.
          Share it with them as an editor first, then come back.
        </p>
      ) : (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">New owner</legend>
          <div className="flex flex-col">
            {eligible.map((share) => (
              <ChoiceRow
                key={share.id}
                name={group}
                value={share.id}
                checked={chosen === share.id}
                onChange={setChosen}
                label={`${share.subject.name} (${share.subject.email})`}
              />
            ))}
          </div>
        </fieldset>
      )}

      {transfer.error && (
        <p role="alert" className="mt-3 text-xs text-[var(--danger-on-tint)]">
          {describeShareError(transfer.error, 'The project could not be transferred.')}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          locked={lock.title}
          disabled={!target || transfer.isPending}
          onClick={() => void confirm()}
        >
          {transfer.isPending && <Spinner />}
          Transfer project
        </Button>
      </DialogFooter>
    </>
  );
}
