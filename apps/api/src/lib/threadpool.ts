import { availableParallelism } from 'node:os';

/**
 * Sizes libuv's thread pool before anything uses it (imported first by
 * server.ts). Password hashing (Better Auth's scrypt through node:crypto)
 * runs there, as do DNS lookups and file reads, and Node's default of four
 * threads made a sign-in storm queue behind itself: at 60 sign-ins a second a
 * replica needs about 3.6 threads of scrypt alone (v0.11 design, item 22;
 * docs/dev/scale-harness.md, "Sign-in storms with shared addresses"). One
 * thread per CPU, between 4 and 16, unless UV_THREADPOOL_SIZE is set.
 */
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.max(4, Math.min(16, availableParallelism())));
}
