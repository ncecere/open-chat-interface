import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ db: {} }));
vi.mock('../../services/chat/pending-approvals.js', () => ({ denyOpenApprovals: vi.fn() }));
vi.mock('../../services/threads.js', () => ({ nextPosition: vi.fn() }));

const { claimRefusal } = await import('../../services/chat/thread-claim.js');

const now = Date.parse('2026-10-05T12:00:00Z');
const silentFor = (ms: number) => claimRefusal(new Date(now - ms), now);

describe('refusing a turn while the thread has an open reply (#121)', () => {
  it('says a reply is being generated while its producer is beating', () => {
    for (const ms of [0, 9_000, 12_000]) {
      const refusal = silentFor(ms);
      expect(refusal.status).toBe(409);
      expect(refusal.message).toBe('A response is already being generated for this thread');
      expect(refusal.retryAfterSeconds).toBeUndefined();
    }
  });

  it('says the reply was interrupted, and when to send again, once the producer has gone quiet', () => {
    const refusal = silentFor(15_000);
    expect(refusal.status).toBe(409);
    expect(refusal.message).toBe(
      'The previous reply in this conversation was interrupted and is being recovered. Send your message again in 5 seconds.',
    );
    expect(refusal.retryAfterSeconds).toBe(5);
    expect(silentFor(19_500).message).toMatch(/again in 1 second\.$/);
    // Past staleMs but not yet recovered (another replica is on it): still a second.
    expect(silentFor(25_000).retryAfterSeconds).toBe(1);
  });

  it('waits for the producer to fall silent in Redis too, when that is later (#163)', () => {
    // The claim alone says 5 s; the heartbeat or last event says 13 s.
    const refusal = claimRefusal(new Date(now - 15_000), now, 12_500);
    expect(refusal.retryAfterSeconds).toBe(13);
    expect(refusal.message).toMatch(/again in 13 seconds\.$/);
    // Redis already quiet: the claim decides, as before.
    expect(claimRefusal(new Date(now - 15_000), now, 0).retryAfterSeconds).toBe(5);
  });
});
