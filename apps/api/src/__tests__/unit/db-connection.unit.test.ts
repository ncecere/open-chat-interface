import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectionLossCount,
  databaseErrorText,
  isConnectionError,
  noteConnectionClosed,
  retryOnConnectionError,
} from '../../lib/db-connection.js';

const lost = (code: string) => Object.assign(new Error(`lost: ${code}`), { code });

afterEach(() => {
  vi.useRealTimers();
});

describe('connection-level database errors (v0.11 failover safety)', () => {
  it.each([
    '57P01',
    '57P02',
    '57P03',
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '25006',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    // The database host does not resolve or cannot be routed to (#230).
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ])('treats %s as a lost connection', (code) => {
    expect(isConnectionError(lost(code))).toBe(true);
  });

  it('finds the driver error under Drizzle’s wrapper, and postgres.js’s errno', () => {
    const wrapped = Object.assign(new Error('Failed query: select 1'), { cause: lost('57P01') });
    expect(isConnectionError(wrapped)).toBe(true);
    expect(isConnectionError({ errno: 'CONNECTION_CLOSED' })).toBe(true);
  });

  it('names a lost connection by the driver’s message, not Drizzle’s failed query (#230)', () => {
    const dns = lost('ENOTFOUND');
    dns.message = 'getaddrinfo ENOTFOUND postgres';
    // DrizzleQueryError's shape: the query, its parameters and the driver error.
    const wrapped = Object.assign(new Error('Failed query: select exists (...)\nparams: '), {
      query: 'select exists (...)',
      params: [],
      cause: dns,
    });
    expect(databaseErrorText(wrapped)).toBe('getaddrinfo ENOTFOUND postgres');
    // Our own explanation keeps its message, though its cause is a lost connection.
    const explained = new Error('Could not reach the database (x)', { cause: wrapped });
    expect(databaseErrorText(explained)).toBe('Could not reach the database (x)');
    expect(databaseErrorText(new Error('relation does not exist'))).toBe('relation does not exist');
  });

  it.each([
    ['a statement error', lost('23505')],
    ['our own pool closing on shutdown', lost('CONNECTION_DESTROYED')],
    ['an error without a code', new Error('boom')],
    ['a non-object', 'boom'],
    ['nothing', undefined],
  ])('does not treat %s as one', (_case, error) => {
    expect(isConnectionError(error)).toBe(false);
  });

  it('counts connections the pool lost', () => {
    const before = connectionLossCount();
    noteConnectionClosed();
    noteConnectionClosed();
    expect(connectionLossCount()).toBe(before + 2);
  });
});

describe('retryOnConnectionError', () => {
  it('retries a lost connection with backoff until the operation succeeds', async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const operation = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(lost('57P01'))
      .mockRejectedValueOnce(lost('ECONNREFUSED'))
      .mockResolvedValue('saved');
    const result = retryOnConnectionError(operation, { initialDelayMs: 100, onRetry });
    await vi.advanceTimersByTimeAsync(300);
    expect(await result).toBe('saved');
    expect(operation.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(onRetry.mock.calls.map(([details]) => details.delayMs)).toEqual([100, 200]);
  });

  it('throws any other error at once', async () => {
    const operation = vi.fn(async () => {
      throw lost('23505');
    });
    await expect(retryOnConnectionError(operation)).rejects.toMatchObject({ code: '23505' });
    expect(operation).toHaveBeenCalledOnce();
  });

  it('gives up with the last connection error once its budget is spent', async () => {
    vi.useFakeTimers();
    const operation = vi.fn(async () => {
      throw lost('CONNECTION_CLOSED');
    });
    const result = retryOnConnectionError(operation, {
      budgetMs: 1_000,
      initialDelayMs: 300,
      maxDelayMs: 400,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toMatchObject({ code: 'CONNECTION_CLOSED' });
    // 300 + 400 + 300 (what was left of the budget), then no time remains.
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('defaults to a 30 second budget', async () => {
    vi.useFakeTimers();
    const operation = vi.fn(async () => {
      throw lost('57P01');
    });
    const result = retryOnConnectionError(operation).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(operation.mock.calls.length).toBeGreaterThan(5);
    const calls = operation.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toMatchObject({ code: '57P01' });
    expect(operation.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
});
