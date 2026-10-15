import {
  type CreateProjectShareInput,
  MAX_SHARES_PER_PROJECT,
  type ProjectShare,
  type ProjectSharePermission,
  shareSubjectInputSchema,
} from '@oci/shared';
import { Trash2, Users } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
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
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import {
  useCreateShare,
  useMyGroups,
  useProjectShares,
  useRemoveShare,
  useUpdateShare,
} from '~/hooks/use-project-sharing';
import { ACCESS_SUMMARY, accessLabel, describeShareError } from '~/lib/project-access';
import { useReadOnlyLock } from '~/lib/read-only';
import { plural } from '~/lib/utils';

/** The spec's sentence, word for word: what sharing means for the people it is shared with. */
export const SHARE_EXPLANATION =
  "People you share with use this project's instructions and files in their own conversations, which stay private to them. Files they add count against their storage.";

const PERMISSION_OPTIONS = [
  { value: 'viewer', label: accessLabel('viewer') },
  { value: 'editor', label: accessLabel('editor') },
];

type Target = 'person' | 'group';

/** The project page's Share button and the dialog it opens. The owner's only. */
export function ShareProjectButton({ project }: { project: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" className="shrink-0" onClick={() => setOpen(true)}>
        <Users aria-hidden="true" />
        Share
      </Button>
      <ShareProjectDialog project={project} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function ShareProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(44rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Share “{project.name}”</DialogTitle>
          <DialogDescription>{SHARE_EXPLANATION}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening reads the list again and starts a blank form. */}
        <ShareBody projectId={project.id} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ShareBody({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const shares = useProjectShares(projectId);
  const groups = useMyGroups();
  const create = useCreateShare(projectId);
  const update = useUpdateShare(projectId);
  const remove = useRemoveShare(projectId);
  const lock = useReadOnlyLock();
  const kind = useId();
  const emailId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<Target>('person');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [groupId, setGroupId] = useState('');
  const [permission, setPermission] = useState<ProjectSharePermission>('viewer');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const current = shares.data ?? [];
  const sharedGroupIds = new Set(
    current.flatMap((share) => (share.subject.type === 'group' ? [share.subject.groupId] : [])),
  );
  const choosable = (groups.data ?? []).filter((group) => !sharedGroupIds.has(group.id));
  const noGroups = !groups.isLoading && (groups.data?.length ?? 0) === 0;
  const pending = create.isPending || update.isPending || remove.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice('');
    setFailure(null);
    setEmailError(null);
    let input: CreateProjectShareInput;
    let label: string;
    if (target === 'person') {
      const subject = shareSubjectInputSchema.safeParse({ type: 'person', email });
      if (!subject.success) {
        setEmailError('Enter a full email address, such as name@example.edu.');
        emailRef.current?.focus();
        return;
      }
      input = { subject: subject.data, permission };
      label = subject.data.type === 'person' ? subject.data.email : '';
    } else {
      const group = choosable.find((candidate) => candidate.id === groupId);
      if (!group) return;
      input = { subject: { type: 'group', groupId: group.id }, permission };
      label = group.name;
    }
    create.mutate(input, {
      onSuccess: () => {
        setNotice(`Shared with ${label}.`);
        if (target === 'person') {
          setEmail('');
          emailRef.current?.focus();
        } else {
          setGroupId('');
        }
      },
      onError: (error) => setFailure(describeShareError(error, 'The project could not be shared.')),
    });
  }

  function changeLevel(share: ProjectShare, next: ProjectSharePermission) {
    if (next === share.permission) return;
    setNotice('');
    setFailure(null);
    update.mutate(
      { shareId: share.id, permission: next },
      {
        onSuccess: () =>
          setNotice(`${shareName(share)} is now ${accessLabel(next).toLowerCase()}.`),
        onError: (error) =>
          setFailure(describeShareError(error, 'The access could not be changed.')),
      },
    );
  }

  function stop(share: ProjectShare) {
    setNotice('');
    setFailure(null);
    remove.mutate(share.id, {
      onSuccess: (result) => {
        const parts = [`Stopped sharing with ${shareName(share)}.`];
        if (result?.detachedThreads)
          parts.push(
            `Their ${plural(result.detachedThreads, 'conversation')} ${result.detachedThreads === 1 ? 'was' : 'were'} kept and left the project.`,
          );
        if (result?.movedFiles)
          parts.push(
            `${plural(result.movedFiles, 'file')} they added now ${result.movedFiles === 1 ? 'belongs' : 'belong'} to you.`,
          );
        setNotice(parts.join(' '));
      },
      onError: (error) => setFailure(describeShareError(error, 'The share could not be removed.')),
    });
  }

  return (
    <>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-[var(--text-secondary)]">
            Share with
          </legend>
          <div className="flex flex-col sm:flex-row sm:gap-2">
            <ChoiceRow
              name={`${kind}-target`}
              value="person"
              checked={target === 'person'}
              onChange={() => setTarget('person')}
              label="A person"
            />
            <ChoiceRow
              name={`${kind}-target`}
              value="group"
              checked={target === 'group'}
              onChange={() => setTarget('group')}
              label="A group"
            />
          </div>
        </fieldset>

        {target === 'person' ? (
          <Field
            label="Their email address"
            htmlFor={emailId}
            hint="Type the exact address they sign in with."
            error={emailError}
          >
            <Input
              id={emailId}
              ref={emailRef}
              type="email"
              value={email}
              autoComplete="off"
              spellCheck={false}
              maxLength={320}
              {...invalidFieldProps(emailId, emailError)}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
            />
          </Field>
        ) : noGroups ? (
          <p className="text-sm text-[var(--text-muted)]">
            You are not in any groups. An administrator or a group manager can add you to one.
          </p>
        ) : (
          <Field
            label="Group"
            htmlFor={`${kind}-group`}
            hint="Only groups you belong to are listed. Everyone in the group gets this access."
          >
            <Select
              id={`${kind}-group`}
              aria-label="Group"
              value={groupId}
              onChange={setGroupId}
              options={choosable.map((group) => ({ value: group.id, label: group.name }))}
              placeholder={
                groups.isLoading
                  ? 'Loading groups…'
                  : choosable.length === 0
                    ? 'Already shared with all of your groups'
                    : 'Choose a group'
              }
              disabled={choosable.length === 0}
            />
          </Field>
        )}

        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-[var(--text-secondary)]">
            Permission
          </legend>
          <div className="flex flex-col">
            {(['viewer', 'editor'] as const).map((level) => (
              <ChoiceRow
                key={level}
                name={`${kind}-permission`}
                value={level}
                checked={permission === level}
                onChange={() => setPermission(level)}
                label={accessLabel(level)}
                hint={ACCESS_SUMMARY[level]}
              />
            ))}
          </div>
        </fieldset>

        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            locked={lock.title}
            disabled={create.isPending || (target === 'group' && (noGroups || groupId === ''))}
          >
            {create.isPending && <Spinner />}
            Share project
          </Button>
        </div>
      </form>

      {/* Announced as each change is made; always in the page so it is heard. */}
      <p role="status" className="mt-3 min-h-5 text-sm text-[var(--success)]">
        {notice}
      </p>
      {failure && (
        <p role="alert" className="mt-1 text-xs text-[var(--danger-on-tint)]">
          {failure}
        </p>
      )}

      <section aria-labelledby={`${kind}-access`} className="mt-4">
        <h3 id={`${kind}-access`} className="text-sm font-semibold">
          Who has access
        </h3>
        {shares.isLoading ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Spinner /> Loading…
          </p>
        ) : shares.error ? (
          <p role="alert" className="mt-2 text-sm text-[var(--danger-on-tint)]">
            {describeShareError(shares.error, 'The list could not be loaded.')}
          </p>
        ) : current.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--text-muted)]">Not shared with anyone yet.</p>
        ) : (
          <>
            <ul aria-label="Who has access" className="mt-2 flex flex-col">
              {current.map((share) => (
                <li
                  key={share.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] py-3 last:border-0"
                >
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="text-sm font-medium wrap-anywhere">{shareName(share)}</p>
                    <p className="text-xs text-[var(--text-muted)] wrap-anywhere">
                      {share.subject.type === 'person'
                        ? share.subject.email
                        : `Group · ${plural(share.subject.memberCount, 'member')}`}
                    </p>
                  </div>
                  <div className="w-32 shrink-0">
                    <Select
                      aria-label={`Access for ${shareName(share)}`}
                      value={share.permission}
                      onChange={(next) => changeLevel(share, next as ProjectSharePermission)}
                      options={PERMISSION_OPTIONS}
                      disabled={pending || Boolean(lock.locked)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Stop sharing with ${shareName(share)}`}
                    locked={lock.title}
                    disabled={pending}
                    onClick={() => stop(share)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              {current.length} of {MAX_SHARES_PER_PROJECT} shares. A group counts as one.
            </p>
          </>
        )}
      </section>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function shareName(share: ProjectShare): string {
  return share.subject.name;
}
