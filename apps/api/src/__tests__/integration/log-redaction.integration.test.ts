import { createHmac, randomUUID } from 'node:crypto';
import { type AddressInfo, createServer } from 'node:net';
import { createDatabase, eq, schema } from '@oci/db';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An address where nothing listens, whatever the environment provides: CI
// runs this suite with DATABASE_URL pointing at a real PostgreSQL (before its
// migrations, so queries happened to fail on missing tables), and
// test/setup.ts only fills it in when unset. Set before the app's database
// and auth modules load.
const UNREACHABLE = 'postgres://oci_test:oci_test@127.0.0.1:1/oci_test';
process.env.DATABASE_URL = UNREACHABLE;
process.env.CONTROL_DATABASE_URL = UNREACHABLE;
const { auth } = await import('../../auth/index.js');
const { db } = await import('../../db/index.js');
const { errorText } = await import('../../lib/log-redaction.js');
const { logger } = await import('../../lib/logger.js');

/**
 * #264: a failed query's parameters (the reply being saved, a session token)
 * must never reach the log, whichever way the error is logged. Real Drizzle
 * queries fail for real (no database answers in this suite: DATABASE_URL
 * points at port 1), and the lines are read from the application logger's
 * own output stream, so the configuration under test is the one in use.
 */

const REPLY_CANARY = 'ZEBRA-CANARY-4417 the reply text';
const TOKEN_CANARY = 'tokencanary4417abcdefghijklmnop';

type Captured = { lines: string[]; console: string[] };

function capture(): Captured {
  const captured: Captured = { lines: [], console: [] };
  const stream = (logger as unknown as Record<symbol, { write(line: string): unknown }>)[
    pino.symbols.streamSym
  ]!;
  vi.spyOn(stream, 'write').mockImplementation((line: string) => {
    captured.lines.push(line);
    return true;
  });
  for (const method of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      captured.console.push(
        args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '),
      );
      // util.inspect shows an error's own properties (its params) too.
      captured.console.push(
        args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : '')).join(' '),
      );
    });
  }
  return captured;
}

/** A real Drizzle update of a reply's parts, as the final save runs it. */
function saveReply(database: typeof db) {
  return database
    .update(schema.message)
    .set({ parts: [{ type: 'text', text: REPLY_CANARY }] })
    .where(eq(schema.message.id, randomUUID()));
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('the query did not fail');
}

/** Every way the code base hands an error to the logger. */
function logEveryWay(error: Error) {
  const runId = randomUUID();
  logger.warn(
    { runId, step: 'message', err: error.message },
    'Database connection lost while saving a reply; retrying',
  );
  logger.error({ error, runId }, 'Failed to persist assistant message');
  logger.error({ err: error, path: '/api/chat' }, 'Unhandled error');
  logger.error(error);
  logger.warn({ err: String(error) }, 'stringified');
  logger.error({ err: new Error('Saving failed', { cause: error }) }, 'wrapped');
  logger.error({ failures: [{ error }] }, 'nested');
  logger.error(`Saving failed: ${error.message}`);
}

describe('log redaction of failed queries (#264)', () => {
  let captured: Captured;
  beforeEach(() => {
    captured = capture();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sources: Array<[string, () => Promise<Error>]> = [
    ['refused connection (the application pool)', () => failure(() => saveReply(db))],
    [
      'connection cut by a proxy',
      async () => {
        // A socket that accepts and then drops the connection, as a proxy or
        // failover does mid-session; local, so it answers at once in any
        // environment (CI's port 1 did not refuse in time behind a proxy).
        const cutter = createServer((socket) => socket.destroy());
        await new Promise<void>((resolve) => cutter.listen(0, '127.0.0.1', resolve));
        const url = new URL(UNREACHABLE);
        url.port = String((cutter.address() as AddressInfo).port);
        const pool = createDatabase(url.toString(), { max: 1 });
        try {
          return await failure(() => saveReply(pool.db as unknown as typeof db));
        } finally {
          await pool.sql.end({ timeout: 1 });
          await new Promise((resolve) => cutter.close(resolve));
        }
      },
    ],
    [
      'closed pool',
      async () => {
        const pool = createDatabase(process.env.DATABASE_URL!, { max: 1 });
        await pool.sql.end({ timeout: 1 });
        return failure(() => saveReply(pool.db as unknown as typeof db));
      },
    ],
  ];

  it.each(sources)('keeps the query and cause but not the parameters: %s', async (_, make) => {
    const error = await make();
    // The precondition: Drizzle's error does carry the reply text.
    expect(error.message).toContain(REPLY_CANARY);
    expect((error as Error & { params?: unknown }).params).toBeDefined();

    logEveryWay(error);

    expect(captured.lines).toHaveLength(8);
    for (const line of captured.lines) {
      expect(line).not.toContain('ZEBRA-CANARY');
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const unhandled = JSON.parse(captured.lines[2]!);
    expect(unhandled.err.message).toContain('Failed query: update "message" set "parts"');
    expect(unhandled.err.params).toBe('[redacted]');
    expect(unhandled.err.query).toContain('update "message"');
    expect(unhandled.err.cause.code).toEqual(expect.any(String));
    // The frames after the message survive the redaction.
    expect(unhandled.err.stack).toContain('\n    at ');
    const persisted = JSON.parse(captured.lines[1]!);
    expect(persisted.error.type).toBe('DrizzleQueryError');
    expect(persisted.runId).toEqual(expect.any(String));
  });

  it('redacts values that look like a stack or like redaction', async () => {
    // A title is bound as raw text: its newlines reach the message unescaped.
    const title = '[redacted]\n    at ZEBRA-CANARY-frame (reply.ts:1:1)\nparams: ZEBRA-CANARY-tail';
    const error = await failure(() =>
      db.update(schema.thread).set({ title }).where(eq(schema.thread.id, randomUUID())),
    );
    expect(error.stack).toContain('ZEBRA-CANARY-frame');

    logEveryWay(error);

    expect(captured.lines.join('\n')).not.toContain('ZEBRA-CANARY');
    expect(JSON.parse(captured.lines[2]!).err.stack).toContain('queryWithCache');
    // What a failed job run or embedding stores and shows.
    expect(errorText(error)).not.toContain('ZEBRA-CANARY');
    expect(errorText(error)).toContain('update "thread" set "title"');
  });

  it('logs a failed session lookup through the application logger without the token', async () => {
    // A cookie signed with the instance's secret, as a signed-in browser sends.
    const signature = createHmac('sha256', process.env.AUTH_SECRET!)
      .update(TOKEN_CANARY)
      .digest('base64');
    const cookie = `oci.session_token=${encodeURIComponent(`${TOKEN_CANARY}.${signature}`)}`;

    const response = await auth.handler(
      new Request(`${process.env.APP_URL}/api/auth/get-session`, { headers: { cookie } }),
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    const everything = [...captured.lines, ...captured.console].join('\n');
    expect(everything).not.toContain(TOKEN_CANARY);
    // The failure is still reported, with its cause, as a JSON line.
    const reported = captured.lines.map((line) => JSON.parse(line)).find((entry) => entry.err);
    expect(reported).toMatchObject({
      component: 'better-auth',
      err: { params: '[redacted]', query: expect.stringContaining('"session"."token"') },
    });
    expect(captured.console).toEqual([]);
  });
});
