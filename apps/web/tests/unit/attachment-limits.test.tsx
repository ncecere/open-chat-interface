// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AttachmentChips } from '../../src/components/chat/attachment-chips';
import { useAttachments } from '../../src/hooks/use-attachments';

vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: { chat: { maxFilesPerMessage: 2, maxFileBytes: 1024 } } }),
}));

let state: ReturnType<typeof useAttachments>;
function Probe() {
  state = useAttachments();
  return <AttachmentChips items={state.items} onRemove={state.remove} />;
}
let container: HTMLDivElement;

let root: Root;
const fetchMock = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let next = 0;
  fetchMock.mockReset().mockImplementation(async () => {
    next += 1;
    return new Response(
      JSON.stringify({
        attachments: [{ id: `attachment-${next}`, filename: 'f', mimeType: 'text/plain' }],
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const file = (name: string, bytes = 10) =>
  new File(['x'.repeat(bytes)], name, { type: 'text/plain' });

it('refuses files over the per-message limit before uploading them', async () => {
  await act(async () => state.upload([file('a.txt'), file('b.txt'), file('c.txt')]));

  // Only the two that fit were uploaded; the third never used storage.
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const byName = Object.fromEntries(state.items.map((item) => [item.filename, item]));
  expect(byName['a.txt']?.status).toBe('ready');
  expect(byName['b.txt']?.status).toBe('ready');
  expect(byName['c.txt']?.status).toBe('error');
  expect(byName['c.txt']?.error).toContain('Only 2 files can be sent with one message');
  expect(state.readyIds).toHaveLength(2);
});

it('refuses a file over the size limit without uploading it', async () => {
  await act(async () => state.upload([file('big.txt', 4096)]));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(state.items[0]?.error).toContain('larger than the');
});

it('frees a place when a file is removed', async () => {
  await act(async () => state.upload([file('a.txt'), file('b.txt')]));
  await act(async () => state.remove(state.items[0]!.localId));
  await act(async () => state.upload([file('c.txt')]));
  expect(state.items.find((item) => item.filename === 'c.txt')?.status).toBe('ready');
});

it('names each refused file once, in words (#180)', async () => {
  // The API's refusal for an .exe renamed .png, as validateUpload words it.
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'walk3-fake.png is a Windows program, which is not allowed here',
          },
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
  );
  await act(async () => state.upload([file('walk3-big.txt', 4096), file('walk3-fake.png')]));
  const reasons = [...container.querySelectorAll('[role="alert"] li')].map((li) => li.textContent);
  expect(reasons).toEqual([
    'walk3-big.txt is larger than the 1.0 KB limit, so it was not uploaded.',
    'walk3-fake.png is a Windows program, which is not allowed here',
  ]);
  // A reason that does not name the file still says which one it is.
  await act(async () => state.upload([file('c.txt'), file('d.txt'), file('e.txt')]));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'e.txt: Only 2 files can be sent with one message',
  );
});
