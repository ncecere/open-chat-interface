// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AttachmentChips } from '../../src/components/chat/attachment-chips';
import type { PendingAttachment } from '../../src/hooks/use-attachments';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const refused = {
  localId: 'local-1',
  filename: 'zip-disguised.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
  status: 'error',
  error: 'zip-disguised.png is an application/zip file, which is not allowed here',
  previewUrl: 'blob:preview',
} as PendingAttachment;

it('says why an upload was refused in visible, announced text', async () => {
  await act(async () => root.render(<AttachmentChips items={[refused]} onRemove={() => {}} />));

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(
    'zip-disguised.png: zip-disguised.png is an application/zip file',
  );
  // The chip points at its reason, and a refused "image" shows no preview.
  const chip = container.querySelector('[aria-describedby="attachment-error-local-1"]');
  expect(chip).not.toBeNull();
  expect(container.querySelector('img')).toBeNull();
});

it('shows no message for files that uploaded', async () => {
  const ready = { ...refused, status: 'ready', error: undefined } as PendingAttachment;
  await act(async () => root.render(<AttachmentChips items={[ready]} onRemove={() => {}} />));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
