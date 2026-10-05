// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAttachments } from '../../src/hooks/use-attachments';

vi.mock('../../src/hooks/use-current-user', () => ({
  useCurrentUser: () => ({ data: { chat: { maxFilesPerMessage: 2, maxFileBytes: 1024 } } }),
}));

let state: ReturnType<typeof useAttachments>;
function Probe() {
  state = useAttachments();
  return null;
}

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
  root = createRoot(document.createElement('div'));
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
