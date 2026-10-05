import { describe, expect, it, vi } from 'vitest';

/**
 * Read-only maintenance mode (v0.11 design, section 9): which of the
 * environment, the administrator's switch and a scheduled window applies, the
 * Retry-After it gives, and which jobs pause.
 */
const state = vi.hoisted(() => ({
  maintenance: {} as unknown,
  env: { OCI_READ_ONLY: false, OCI_READ_ONLY_REASON: undefined as string | undefined },
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: async () => {
    if (state.maintenance instanceof Error) throw state.maintenance;
    return state.maintenance;
  },
}));
vi.mock('../../config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/env.js')>();
  return { ...original, loadEnv: () => ({ ...original.loadEnv(), ...state.env }) };
});

const {
  evaluateReadOnly,
  jobPausedByReadOnly,
  keepRunningJobs,
  readOnlyHealthCheck,
  retryAfterSeconds,
} = await import('../../services/maintenance/read-only.js');

const now = Date.parse('2026-10-04T12:00:00.000Z');
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const off = { OCI_READ_ONLY: false };

describe('read-only state', () => {
  it('is off with nothing saved', () => {
    expect(evaluateReadOnly({}, off, now)).toEqual({
      active: false,
      source: null,
      reason: null,
      until: null,
      window: null,
    });
  });

  it('follows the administrator, with an expected end only while it is ahead', () => {
    expect(
      evaluateReadOnly({ readOnly: true, reason: 'Upgrade', until: at(30) }, off, now),
    ).toEqual({
      active: true,
      source: 'administrator',
      reason: 'Upgrade',
      until: at(30),
      window: null,
    });
    expect(evaluateReadOnly({ readOnly: true, until: at(-5) }, off, now).until).toBeNull();
    expect(evaluateReadOnly({ readOnly: true, until: 'not a date' }, off, now).until).toBeNull();
  });

  it('applies a window from its start until its end, and shows it before', () => {
    const stored = { window: { startsAt: at(10), endsAt: at(70), reason: 'Moving' } };
    expect(evaluateReadOnly(stored, off, now)).toMatchObject({
      active: false,
      window: { startsAt: at(10), endsAt: at(70) },
    });
    expect(evaluateReadOnly(stored, off, now + 10 * 60_000)).toMatchObject({
      active: true,
      source: 'schedule',
      reason: 'Moving',
      until: at(70),
    });
    expect(evaluateReadOnly(stored, off, now + 70 * 60_000)).toMatchObject({
      active: false,
      window: null,
    });
    // A window that makes no sense is ignored.
    expect(
      evaluateReadOnly({ window: { startsAt: at(10), endsAt: at(5) } }, off, now + 7 * 60_000)
        .active,
    ).toBe(false);
    expect(evaluateReadOnly({ window: { startsAt: 'x', endsAt: at(5) } }, off, now).window).toBe(
      null,
    );
  });

  it('lets the environment win, with its own reason', () => {
    const stored = { readOnly: false, reason: 'Saved reason', window: null };
    expect(
      evaluateReadOnly(stored, { OCI_READ_ONLY: true, OCI_READ_ONLY_REASON: 'Restoring' }, now),
    ).toMatchObject({ active: true, source: 'environment', reason: 'Restoring', until: null });
    expect(evaluateReadOnly(stored, { OCI_READ_ONLY: true }, now).reason).toBe('Saved reason');
    // The administrator's switch wins over a window, and keeps the window shown.
    expect(
      evaluateReadOnly({ readOnly: true, window: { startsAt: at(-5), endsAt: at(5) } }, off, now),
    ).toMatchObject({ source: 'administrator', window: { endsAt: at(5) } });
  });

  it('gives Retry-After in whole seconds, at least one, only when the end is known', () => {
    const status = evaluateReadOnly({ readOnly: true, until: at(30) }, off, now);
    expect(retryAfterSeconds(status, now)).toBe(1_800);
    expect(retryAfterSeconds(status, now + 30 * 60_000 - 10)).toBe(1);
    expect(retryAfterSeconds(status, now + 31 * 60_000)).toBeNull();
    expect(retryAfterSeconds(evaluateReadOnly({ readOnly: true }, off, now), now)).toBeNull();
    expect(retryAfterSeconds(evaluateReadOnly({}, off, now), now)).toBeNull();
  });

  it('keeps backups, compliance exports, webhooks and reply recovery running by default', () => {
    expect(keepRunningJobs({})).toEqual([
      'backups.run',
      'compliance.export',
      'webhooks.deliver',
      'chat.recover-interrupted-replies',
    ]);
    expect(keepRunningJobs({ keepRunningJobs: [] })).toEqual([]);
  });

  it('pauses jobs only while read-only, apart from those kept running', async () => {
    state.maintenance = {};
    expect(await jobPausedByReadOnly('imports.process')).toBe(false);
    state.maintenance = { readOnly: true };
    expect(await jobPausedByReadOnly('imports.process')).toBe(true);
    expect(await jobPausedByReadOnly('backups.run')).toBe(false);
    state.maintenance = { readOnly: true, keepRunningJobs: ['imports.process'] };
    expect(await jobPausedByReadOnly('imports.process')).toBe(false);
    expect(await jobPausedByReadOnly('backups.run')).toBe(true);
    // The setting cannot be read: jobs run (they would meet the database anyway).
    state.maintenance = new Error('database away');
    expect(await jobPausedByReadOnly('imports.process')).toBe(false);
    state.env.OCI_READ_ONLY = true;
    state.maintenance = {};
    expect(await jobPausedByReadOnly('imports.process')).toBe(true);
    state.env.OCI_READ_ONLY = false;
  });

  it('describes itself on System health', async () => {
    state.maintenance = {};
    expect(await readOnlyHealthCheck()).toMatchObject({ status: 'ok', detail: /Off/ });
    state.maintenance = {
      window: { startsAt: new Date(Date.now() + 60_000).toISOString(), endsAt: at(100_000) },
    };
    expect(await readOnlyHealthCheck()).toMatchObject({ status: 'ok', detail: /Scheduled/ });
    state.maintenance = { readOnly: true, reason: 'Upgrade', until: at(100_000) };
    expect(await readOnlyHealthCheck()).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/an administrator.*Reason: Upgrade/),
    });
    state.env.OCI_READ_ONLY = true;
    expect((await readOnlyHealthCheck()).detail).toContain('OCI_READ_ONLY');
    state.env.OCI_READ_ONLY = false;
    state.maintenance = {
      window: { startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: at(100_000) },
    };
    expect((await readOnlyHealthCheck()).detail).toContain('a scheduled window');
  });
});
