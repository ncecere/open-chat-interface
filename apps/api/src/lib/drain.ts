import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { ERROR_CODES } from '@oci/shared';

/**
 * Draining on shutdown (v0.11 design, item 13).
 *
 * From the first SIGTERM or SIGINT a replica:
 *
 * - reports not-ready (`/api/health/ready` answers 503 with the reason) while
 *   liveness stays 200, so an orchestrator stops routing to it but does not
 *   restart it;
 * - refuses new chat turns with `503`, `Retry-After` and `Connection: close`
 *   before reading them, so nothing is stored and the client (or a proxy that
 *   retries 503s) sends the turn again, to another replica;
 * - answers every other request as usual, but with `Connection: close`, so a
 *   proxy's pooled keep-alive connections stop carrying new requests here;
 * - lets replies in progress finish, up to SHUTDOWN_DRAIN_TIMEOUT_MS, then has
 *   each remaining one saved as interrupted (see services/chat/active-runs.ts).
 *
 * Why refuse turns with a status instead of closing the listener at once: a
 * closed listener also fails the readiness and liveness probes (an
 * orchestrator may restart the container mid-drain), and a proxy cannot tell a
 * refused connection from a dead replica. A 503 before any work is the
 * standard "try elsewhere" answer; the web app retries it transparently, and
 * the bundled Caddy takes a replica that answers 503 out of rotation
 * (passive health, `unhealthy_status 503`).
 */

export interface DrainState {
  /** The signal or other reason the drain began. */
  reason: string;
  since: number;
}

let state: DrainState | null = null;
let turnsInFlight = 0;

/** Starts draining; later calls keep the first reason. */
export function beginDrain(reason: string): DrainState {
  state ??= { reason, since: Date.now() };
  return state;
}

export function drainState(): DrainState | null {
  return state;
}

export function isDraining(): boolean {
  return state !== null;
}

/** Seconds a refused client should wait before sending again. Another replica is ready. */
export const DRAIN_RETRY_AFTER_SECONDS = 1;

/** Marks responses refused because this replica is draining, for clients and logs. */
export const DRAINING_HEADER = 'X-OCI-Draining';

/** Requests that start a reply: a message (or retry), and continuing after approvals. */
export function isNewChatTurn(method: string, pathname: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  return /^\/api\/chat\/?$/.test(pathname) || /^\/api\/chat\/[^/]+\/approvals\/?$/.test(pathname);
}

export function drainRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: {
        // A planned restart, not a fault: clients and logs can tell them apart.
        code: ERROR_CODES.SERVER_RESTARTING,
        message: 'This server is restarting. Send your message again in a moment.',
      },
    }),
    {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'retry-after': String(DRAIN_RETRY_AFTER_SECONDS),
        connection: 'close',
        [DRAINING_HEADER]: '1',
      },
    },
  );
}

/** Chat turns accepted before the drain whose reply has not started yet. */
export function chatTurnsBeingAdmitted(): number {
  return turnsInFlight;
}

type FetchHandler = (request: Request, ...rest: never[]) => Response | Promise<Response>;

/**
 * Wraps the application's fetch handler: refuses new chat turns while
 * draining, and counts the ones accepted before it until their reply starts
 * (setup can take a few seconds; the reply is tracked from then on).
 */
export function withDrain<F extends FetchHandler>(fetch: F): F {
  return ((request: Request, ...rest: never[]) => {
    const turn = isNewChatTurn(request.method, new URL(request.url).pathname);
    if (!turn) return fetch(request, ...rest);
    if (state) return drainRefusal();
    turnsInFlight++;
    let counted = true;
    const done = () => {
      if (counted) turnsInFlight--;
      counted = false;
    };
    try {
      return Promise.resolve(fetch(request, ...rest)).finally(done);
    } catch (error) {
      done();
      throw error;
    }
  }) as F;
}

/**
 * Adds `Connection: close` to every response sent while draining. Runs
 * before the application's own listener, so the header is in place before
 * any response is written; Node then closes the socket after that response.
 */
export function closeConnectionsWhileDraining(server: Server): void {
  server.prependListener('request', (_request: IncomingMessage, response: ServerResponse) => {
    if (state) response.setHeader('Connection', 'close');
  });
}

export async function waitUntil(
  remaining: () => number,
  deadline: number,
  intervalMs = 50,
): Promise<number> {
  while (remaining() > 0 && Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())),
    );
  }
  return remaining();
}

interface ShutdownLog {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
  error: (details: Record<string, unknown>, message: string) => void;
}

export interface ShutdownOptions {
  server: Server;
  /** How long replies in progress may keep running (SHUTDOWN_DRAIN_TIMEOUT_MS). */
  drainTimeoutMs: number;
  /** How long interrupted replies get to save after the drain limit. */
  interruptGraceMs?: number;
  /** How long open requests get to finish once the listener is closed. */
  closeGraceMs?: number;
  /** Stops intake that is not HTTP, such as job timers. */
  stopIntake: () => void;
  /** Work still in progress on this replica: replies, turns being set up, jobs. */
  workInProgress: () => number;
  /** Ends replies still running at the limit, each saved with what it has. Returns how many. */
  interruptWork: () => number;
  /** Ends long-lived readers (replay streams) before the server closes. */
  endStreams?: () => void;
  /**
   * Replay readers still sending. Once the replies are done they get
   * `streamGraceMs` to finish on their own before `endStreams` cuts them: a
   * reader a few frames behind a reply that has just finished would
   * otherwise end without it, and with a single replica there is nowhere
   * else to resume. A reader of a reply still running elsewhere is ended
   * after the grace, as before.
   */
  openStreams?: () => number;
  streamGraceMs?: number;
  /** Closes database, Redis and tracing. */
  closeResources: () => Promise<void>;
  exit: (code: number) => void;
  log: ShutdownLog;
}

function closeServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(idle);
      resolve();
    };
    // Stops listening and closes idle keep-alive connections. A response that
    // began before the drain has no `Connection: close`, so its connection
    // goes idle afterwards instead of closing: close those as they do.
    server.close(() => finish());
    const idle = setInterval(() => server.closeIdleConnections(), 50);
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, graceMs);
    timer.unref();
    idle.unref();
  });
}

/**
 * Returns the signal handler. The first signal drains and exits 0 (1 if
 * something failed on the way); a second one exits 1 at once.
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { log } = options;
  let running: Promise<void> | null = null;
  return (signal: string) => {
    if (running) {
      log.warn({ signal }, 'Second shutdown signal: exiting without waiting');
      options.exit(1);
      return running;
    }
    const startedAt = Date.now();
    beginDrain(signal);
    log.info(
      { signal, drainTimeoutMs: options.drainTimeoutMs, inProgress: options.workInProgress() },
      'Shutting down: not ready, refusing new chat turns, finishing replies in progress',
    );
    running = (async () => {
      let code = 0;
      try {
        options.stopIntake();
        let left = await waitUntil(options.workInProgress, startedAt + options.drainTimeoutMs);
        if (left > 0) {
          const interrupted = options.interruptWork();
          log.warn(
            { interrupted, drainTimeoutMs: options.drainTimeoutMs },
            'Drain limit reached; saving the remaining replies as interrupted',
          );
          left = await waitUntil(
            options.workInProgress,
            Date.now() + (options.interruptGraceMs ?? 3_000),
          );
          if (left > 0) log.warn({ left }, 'Work still running at exit');
        }
        if (options.openStreams) {
          await waitUntil(options.openStreams, Date.now() + (options.streamGraceMs ?? 2_000));
        }
        options.endStreams?.();
        await closeServer(options.server, options.closeGraceMs ?? 2_000);
      } catch (error) {
        code = 1;
        log.error(
          { err: error instanceof Error ? error.message : String(error) },
          'Shutdown did not drain cleanly',
        );
      }
      try {
        await options.closeResources();
      } catch (error) {
        log.error(
          { err: error instanceof Error ? error.message : String(error) },
          'Closing connections failed',
        );
      }
      log.info({ ms: Date.now() - startedAt, code }, 'Shutdown complete');
      options.exit(code);
    })();
    return running;
  };
}

/** Test seam: forget a drain started by an earlier test. */
export function resetDrainForTests(): void {
  state = null;
  turnsInFlight = 0;
}
