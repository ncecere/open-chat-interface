// @vitest-environment happy-dom
import type { ThreadSummary } from '@oci/shared';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { Toaster } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadList } from '../../src/components/layout/thread-list';
import {
  button,
  cleanup,
  click,
  dismissToasts,
  findButton,
  renderAdmin,
  settle,
} from './admin-test-utils';

/**
 * How long the archive notice with Undo stays (#205), through the real
 * sidebar row, query cache, API client and Sonner toaster, with a fake clock.
 * Sonner's default of 4 seconds took the notice away before people reached
 * Undo; reaching it with Tab did not stop the clock either.
 */
const network = vi.hoisted(() => {
  const state = {
    handler: (async () => new Response(null, { status: 404 })) as (
      request: Request,
    ) => Promise<Response>,
  };
  globalThis.fetch = (input, init) =>
    state.handler(
      new Request(
        new URL(String(input instanceof Request ? input.url : input), 'http://localhost:3000'),
        init,
      ),
    );
  return state;
});

const NOW = new Date().toISOString();
const thread = {
  id: 't1',
  title: 'Trip plans',
  pinned: false,
  archived: false,
  projectId: null,
  parentThreadId: null,
  temporary: false,
  createdAt: NOW,
  updatedAt: NOW,
  lastMessageAt: NOW,
} as unknown as ThreadSummary;

const writes: string[] = [];
let root: Root | undefined;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  writes.length = 0;
  let archived = false;
  network.handler = async (request) => {
    const { pathname, search } = new URL(request.url);
    if (request.method === 'PATCH') {
      const body = (await request.json()) as { archived: boolean };
      writes.push(`${pathname} archived=${body.archived}`);
      archived = body.archived;
      return Response.json({ thread: { ...thread, archived } });
    }
    if (pathname === '/api/threads' && search === '?view=sidebar')
      return Response.json({ threads: archived ? [] : [thread] });
    return new Response(null, { status: 404 });
  };
});
afterEach(async () => {
  await dismissToasts();
  if (root) await cleanup(root);
  root = undefined;
  vi.useRealTimers();
});

async function archive() {
  ({ root } = await renderAdmin(
    <>
      <ThreadList />
      <Toaster />
    </>,
  ));
  await click(button('Archive conversation: Trip plans'));
  await vi.waitFor(() => expect(notice()).toContain('Conversation archived'));
}

/** The notice's text while it is showing (not on its way out). */
const notice = () =>
  document.querySelector('[data-sonner-toast]:not([data-removed="true"])')?.textContent ?? null;

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

describe('the archive notice with Undo (#205)', () => {
  it('stays long enough to reach Undo, then goes', async () => {
    await archive();
    await wait(8_000);
    expect(notice()).toContain('Undo');
    await wait(3_000);
    expect(notice()).toBeNull();
  });

  it('stays while Undo has keyboard focus, and gets its time again after', async () => {
    await archive();
    await wait(5_000);
    await act(async () => button('Undo').focus());
    await wait(60_000);
    expect(notice()).toContain('Trip plans');
    await act(async () => button('Undo').blur());
    await wait(8_000);
    expect(notice()).toContain('Undo');
    await wait(3_000);
    expect(notice()).toBeNull();
  });

  it('restores the conversation from Undo and closes the notice', async () => {
    await archive();
    await wait(5_000);
    await click(button('Undo'));
    await wait(500);
    expect(writes).toEqual(['/api/threads/t1 archived=true', '/api/threads/t1 archived=false']);
    expect(notice()).toBeNull();
    expect(findButton('Undo')).toBeUndefined();
    await vi.waitFor(() => expect(findButton('Archive conversation: Trip plans')).toBeDefined());
  });
});
