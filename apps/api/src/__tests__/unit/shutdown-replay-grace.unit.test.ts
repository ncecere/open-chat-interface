import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createShutdown, resetDrainForTests } from '../../lib/drain.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const fakeServer = {
  close: (done: () => void) => done(),
  closeIdleConnections: () => {},
  closeAllConnections: () => {},
} as unknown as Server;

function shutdownWith(readers: { open: number }, events: string[], streamGraceMs = 2_000) {
  return createShutdown({
    server: fakeServer,
    drainTimeoutMs: 1_000,
    stopIntake: () => {},
    workInProgress: () => 0,
    interruptWork: () => 0,
    openStreams: () => readers.open,
    streamGraceMs,
    endStreams: () => events.push(`ended with ${readers.open} open`),
    closeResources: async () => {},
    exit: () => events.push('exit'),
    log: quiet,
  });
}

afterEach(() => resetDrainForTests());

describe('shutdown and replay readers', () => {
  it('lets a reader still catching up on a finished reply finish before ending readers', async () => {
    const readers = { open: 1 };
    const events: string[] = [];
    // The reader sends the rest of the reply's frames a moment later.
    setTimeout(() => {
      readers.open = 0;
    }, 150);
    await shutdownWith(readers, events)('SIGTERM');
    expect(events).toEqual(['ended with 0 open', 'exit']);
  });

  it('ends a reader that is still open after the grace, as before', async () => {
    const readers = { open: 1 };
    const events: string[] = [];
    const started = Date.now();
    await shutdownWith(readers, events, 200)('SIGTERM');
    expect(events).toEqual(['ended with 1 open', 'exit']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });
});

describe('the refusal of a new turn while draining', () => {
  it('says the server is restarting, not that something failed', async () => {
    const { drainRefusal } = await import('../../lib/drain.js');
    const response = drainRefusal();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({
      error: {
        code: 'SERVER_RESTARTING',
        message: 'This server is restarting. Send your message again in a moment.',
      },
    });
  });
});
