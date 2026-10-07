// @vitest-environment happy-dom
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../src/components/admin/confirm-dialog';
import { Dialog } from '../../src/components/ui/dialog';
import { AdminInvitesPage } from '../../src/routes/admin/invites';
import { WebhookFormDialog } from '../../src/routes/admin/webhooks/webhook-form-dialog';
import { cleanup, click, dialog, renderAdmin } from './admin-test-utils';
import { styleFor } from './css-test-utils';

/**
 * #199: at 390 px some dialogs were cards 16 px in from each edge, others
 * full-bleed (the shared base was w-full), and some stacked their actions
 * with Cancel underneath while the rest kept a right-aligned pair. Real
 * dialogs, their compiled CSS resolved at a 390 px window.
 */
const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

const WINDOW = 390;

/** The dialog's left and right edges at the window width (base styles: the phone's). */
async function edges(element: Element) {
  const style = await styleFor(element.getAttribute('class') ?? '');
  const width = style.width ?? 'auto';
  const inset = width.match(/^calc\(100% - ([\d.]+)rem\)$/);
  const px = inset ? WINDOW - Number(inset[1]) * 16 : width === '100%' ? WINDOW : Number.NaN;
  // Centred: left-1/2 with a -50% translation.
  const left = (WINDOW - px) / 2;
  return { left, right: left + px };
}

async function footerDirection(element: Element) {
  const footer = [...element.querySelectorAll('div')].find((node) =>
    [...node.querySelectorAll(':scope > button')].some((b) => b.textContent?.trim() === 'Cancel'),
  );
  expect(footer, 'a footer with Cancel').toBeDefined();
  return (await styleFor(footer!.getAttribute('class') ?? ''))['flex-direction'] ?? 'row';
}

let root: Root | undefined;
beforeEach(() => {
  for (const method of Object.values(api)) method.mockReset();
  api.get.mockResolvedValue({ invites: [], events: [] });
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

describe('dialogs at 390 px (#199)', () => {
  it('Create invitation: a 16 px inset card with a row of actions', async () => {
    ({ root } = await renderAdmin(<AdminInvitesPage />));
    await click(
      [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === 'Create invitation',
      )!,
    );
    expect(await edges(dialog()!)).toEqual({ left: 16, right: 374 });
    expect(await footerDirection(dialog()!)).toBe('row');
  });

  it('a confirmation (Ban, Sign out everywhere): the same', async () => {
    ({ root } = await renderAdmin(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Ban this account?"
        description="They are signed out."
        confirmLabel="Ban"
        pendingLabel="Banning…"
        errorMessage="Could not ban."
        onConfirm={async () => undefined}
      />,
    ));
    expect(await edges(dialog()!)).toEqual({ left: 16, right: 374 });
    expect(await footerDirection(dialog()!)).toBe('row');
  });

  it('Add endpoint, full-bleed before: the same', async () => {
    ({ root } = await renderAdmin(
      <Dialog open>
        <WebhookFormDialog
          endpoint={null}
          knownActions={[]}
          onClose={() => undefined}
          onCreated={() => undefined}
        />
      </Dialog>,
    ));
    expect(await edges(dialog()!)).toEqual({ left: 16, right: 374 });
    expect(await footerDirection(dialog()!)).toBe('row');
  });
});
