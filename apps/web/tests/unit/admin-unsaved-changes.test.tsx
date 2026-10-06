// @vitest-environment happy-dom
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnsavedChangesGuard, useReportUnsaved } from '../../src/components/admin/unsaved-changes';
import { Dialog, DialogContent, DialogTitle } from '../../src/components/ui/dialog';
import { StorageSettingsForm } from '../../src/routes/admin/storage/storage-settings-form';
import { cleanup, dialog, renderAdmin, settle, typeInto } from './admin-test-utils';

let root: Root | undefined;
let confirm: ReturnType<typeof vi.fn<(message?: string) => boolean>>;
beforeEach(() => {
  // happy-dom has no window.confirm; the browser's is what the code calls.
  confirm = vi.fn<(message?: string) => boolean>(() => false);
  Object.defineProperty(window, 'confirm', { value: confirm, configurable: true, writable: true });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
  vi.restoreAllMocks();
});

function Form() {
  const [value, setValue] = useState('');
  useReportUnsaved(value !== '');
  return (
    <input
      aria-label="Messages per minute"
      value={value}
      onChange={(e) => setValue(e.target.value)}
    />
  );
}

const field = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Messages per minute"]')!;

it('asks before leaving a page with unsaved changes, and stays when told to', async () => {
  let router!: Awaited<ReturnType<typeof renderAdmin>>['router'];
  ({ root, router } = await renderAdmin(
    <UnsavedChangesGuard>
      <Form />
    </UnsavedChangesGuard>,
    { path: '/admin/roles' },
  ));
  await typeInto(field(), '30');

  // A blocked navigation never settles, so it is not awaited.
  await act(async () => {
    void router.navigate({ to: '/admin/quotas' as never });
  });
  await settle();
  expect(confirm).toHaveBeenCalledOnce();
  expect(router.state.location.pathname).toBe('/admin/roles');

  confirm.mockReturnValue(true);
  await act(async () => {
    await router.navigate({ to: '/admin/quotas' as never });
  });
  expect(router.state.location.pathname).toBe('/admin/quotas');
});

it('leaves without asking when nothing was changed', async () => {
  let router!: Awaited<ReturnType<typeof renderAdmin>>['router'];
  ({ root, router } = await renderAdmin(
    <UnsavedChangesGuard>
      <Form />
    </UnsavedChangesGuard>,
    { path: '/admin/roles' },
  ));
  await act(async () => {
    await router.navigate({ to: '/admin/quotas' as never });
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(router.state.location.pathname).toBe('/admin/quotas');
});

it('switches Storage tabs without asking, since every tab shares one kept draft', async () => {
  // Storage keeps all three panels mounted on one draft, so changing tab loses
  // nothing; asking "Leave without saving them?" there was wrong, and saying no
  // left the person unable to reach the other tabs before saving.
  let router!: Awaited<ReturnType<typeof renderAdmin>>['router'];
  ({ root, router } = await renderAdmin(
    <UnsavedChangesGuard>
      <StorageSettingsForm
        initialSettings={{
          driver: 'local',
          localPath: '/data/attachments',
          maxFileBytes: 10_485_760,
          maxFilesPerMessage: 5,
          allowedMimeTypes: ['image/png'],
          s3: {
            bucket: 'attachments',
            region: 'us-east-1',
            endpoint: null,
            accessKeyId: 'access-id',
            forcePathStyle: false,
            hasCredential: true,
          },
        }}
      />
    </UnsavedChangesGuard>,
    { path: '/admin/storage?tab=uploads' },
  ));
  const limit = () => document.querySelector<HTMLInputElement>('#max-files-per-message')!;
  await typeInto(limit(), '6');
  const tab = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (element) => element.textContent === name,
    )!;

  await act(async () => tab('S3 connection').click());
  await settle();
  expect(confirm).not.toHaveBeenCalled();
  expect(router.state.location.search).toEqual({ tab: 's3' });
  await act(async () => tab('Upload policy').click());
  await settle();
  expect(router.state.location.search).toEqual({ tab: 'uploads' });
  expect(limit().value).toBe('6');
  expect(confirm).not.toHaveBeenCalled();
});

/** Like a real key press, the event can be cancelled (the shared helper's cannot). */
async function pressCancelableEscape() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

it('asks before Escape discards a half-filled dialog', async () => {
  function Half() {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent confirmDiscard aria-describedby={undefined}>
          <DialogTitle>New policy</DialogTitle>
          <input aria-label="Name" defaultValue="Walk half" />
        </DialogContent>
      </Dialog>
    );
  }
  ({ root } = await renderAdmin(<Half />));
  await pressCancelableEscape();
  expect(confirm).toHaveBeenCalledOnce();
  expect(dialog()).not.toBeNull();

  confirm.mockReturnValue(true);
  await pressCancelableEscape();
  expect(dialog()).toBeNull();
});
