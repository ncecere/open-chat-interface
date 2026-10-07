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
  error: 'zip-disguised.png is a ZIP archive, which is not allowed here',
  previewUrl: 'blob:preview',
} as PendingAttachment;

it('says why an upload was refused in visible, announced text', async () => {
  await act(async () => root.render(<AttachmentChips items={[refused]} onRemove={() => {}} />));

  const alert = container.querySelector('[role="alert"]');
  // Named once: the reason already starts with the file's name (#180).
  expect(alert?.textContent).toBe('zip-disguised.png is a ZIP archive, which is not allowed here');
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

it('shows a document, not a broken image, while a file named .png that is not one uploads (#209)', async () => {
  const uploading = {
    ...refused,
    filename: 'walk3-fake.png',
    status: 'uploading',
    error: undefined,
  } as PendingAttachment;
  await act(async () => root.render(<AttachmentChips items={[uploading]} onRemove={() => {}} />));
  const preview = container.querySelector('img');
  expect(preview).not.toBeNull();
  // The browser could not draw it: the bytes are text.
  await act(async () => preview!.dispatchEvent(new Event('error')));
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('walk3-fake.png');
});
