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
import { useT } from '~/lib/i18n';
import { accessLabel, accessSummary, describeShareError } from '~/lib/project-access';
import { isolate } from '~/lib/projects-text';
import { useReadOnlyLock } from '~/lib/read-only';

type Target = 'person' | 'group';

/** The project page's Share button and the dialog it opens. The owner's only. */
export function ShareProjectButton({ project }: { project: { id: string; name: string } }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" className="shrink-0" onClick={() => setOpen(true)}>
        <Users aria-hidden="true" />
        {t('sharing.dialog.open')}
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
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(44rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('sharing.dialog.title', { name: isolate(project.name) })}</DialogTitle>
          {/* What sharing means for the people it is shared with: said in full in every language. */}
          <DialogDescription>{t('sharing.dialog.explanation')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening reads the list again and starts a blank form. */}
        <ShareBody projectId={project.id} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ShareBody({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const t = useT();
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
  const permissionOptions = (['viewer', 'editor'] as const).map((level) => ({
    value: level,
    label: accessLabel(level),
  }));
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
        setEmailError(t('sharing.dialog.emailInvalid'));
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
        setNotice(t('sharing.notice.shared', { name: isolate(label) }));
        if (target === 'person') {
          setEmail('');
          emailRef.current?.focus();
        } else {
          setGroupId('');
        }
      },
      onError: (error) => setFailure(describeShareError(error, t('sharing.dialog.shareFailed'))),
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
          setNotice(
            t(next === 'editor' ? 'sharing.notice.nowEditor' : 'sharing.notice.nowViewer', {
              name: isolate(shareName(share)),
            }),
          ),
        onError: (error) => setFailure(describeShareError(error, t('sharing.dialog.changeFailed'))),
      },
    );
  }

  function stop(share: ProjectShare) {
    setNotice('');
    setFailure(null);
    remove.mutate(share.id, {
      onSuccess: (result) => {
        const parts = [t('sharing.notice.stopped', { name: isolate(shareName(share)) })];
        if (result?.detachedThreads)
          parts.push(t('sharing.notice.detachedThreads', { count: result.detachedThreads }));
        if (result?.movedFiles)
          parts.push(t('sharing.notice.movedFiles', { count: result.movedFiles }));
        setNotice(parts.join(' '));
      },
      onError: (error) => setFailure(describeShareError(error, t('sharing.dialog.removeFailed'))),
    });
  }

  return (
    <>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-[var(--text-secondary)]">
            {t('sharing.dialog.shareWith')}
          </legend>
          <div className="flex flex-col sm:flex-row sm:gap-2">
            <ChoiceRow
              name={`${kind}-target`}
              value="person"
              checked={target === 'person'}
              onChange={() => setTarget('person')}
              label={t('sharing.dialog.targetPerson')}
            />
            <ChoiceRow
              name={`${kind}-target`}
              value="group"
              checked={target === 'group'}
              onChange={() => setTarget('group')}
              label={t('sharing.dialog.targetGroup')}
            />
          </div>
        </fieldset>

        {target === 'person' ? (
          <Field
            label={t('sharing.dialog.emailLabel')}
            htmlFor={emailId}
            hint={t('sharing.dialog.emailHint')}
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
          <p className="text-sm text-[var(--text-muted)]">{t('sharing.dialog.noGroups')}</p>
        ) : (
          <Field
            label={t('sharing.dialog.groupLabel')}
            htmlFor={`${kind}-group`}
            hint={t('sharing.dialog.groupHint')}
          >
            <Select
              id={`${kind}-group`}
              aria-label={t('sharing.dialog.groupLabel')}
              value={groupId}
              onChange={setGroupId}
              options={choosable.map((group) => ({ value: group.id, label: group.name }))}
              placeholder={
                groups.isLoading
                  ? t('sharing.dialog.groupsLoading')
                  : choosable.length === 0
                    ? t('sharing.dialog.groupsAllShared')
                    : t('sharing.dialog.groupPlaceholder')
              }
              disabled={choosable.length === 0}
            />
          </Field>
        )}

        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-[var(--text-secondary)]">
            {t('sharing.dialog.permission')}
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
                hint={accessSummary(level)}
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
            {t('sharing.dialog.submit')}
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
          {t('sharing.list.title')}
        </h3>
        {shares.isLoading ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Spinner /> {t('sharing.list.loading')}
          </p>
        ) : shares.error ? (
          <p role="alert" className="mt-2 text-sm text-[var(--danger-on-tint)]">
            {describeShareError(shares.error, t('sharing.list.loadFailed'))}
          </p>
        ) : current.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--text-muted)]">{t('sharing.list.empty')}</p>
        ) : (
          <>
            <ul aria-label={t('sharing.list.title')} className="mt-2 flex flex-col">
              {current.map((share) => (
                <li
                  key={share.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--border-subtle)] py-3 last:border-0"
                >
                  <div className="min-w-0 flex-1 basis-40">
                    <p dir="auto" className="text-sm font-medium wrap-anywhere">
                      {shareName(share)}
                    </p>
                    <p className="text-xs text-[var(--text-muted)] wrap-anywhere">
                      {share.subject.type === 'person' ? (
                        <bdi>{share.subject.email}</bdi>
                      ) : (
                        t('sharing.list.groupMeta', { count: share.subject.memberCount })
                      )}
                    </p>
                  </div>
                  <div className="w-32 shrink-0">
                    <Select
                      aria-label={t('sharing.list.accessFor', { name: isolate(shareName(share)) })}
                      value={share.permission}
                      onChange={(next) => changeLevel(share, next as ProjectSharePermission)}
                      options={permissionOptions}
                      disabled={pending || Boolean(lock.locked)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('sharing.list.stop', { name: isolate(shareName(share)) })}
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
              {t('sharing.list.count', {
                count: current.length,
                max: MAX_SHARES_PER_PROJECT,
              })}
            </p>
          </>
        )}
      </section>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('sharing.dialog.done')}
        </Button>
      </DialogFooter>
    </>
  );
}

function shareName(share: ProjectShare): string {
  return share.subject.name;
}
