import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '@oci/db';

/**
 * Which database the shared `db` (db/index.ts) answers with for the code
 * running inside `withDatabase` (v0.11 design, section 11, read routing).
 *
 * Read routing changes where a whole administrative report reads from
 * (`onReadReplica`, db/read.ts) without passing a different client through
 * every function it calls: inside the scope, every query made through `db`,
 * in this async context, goes to the replica. Outside it (and in anything the
 * scope did not start) `db` is the primary, as always.
 */
const scope = new AsyncLocalStorage<Database>();

/** Runs `work` with `db` answering from `database`. */
export function withDatabase<T>(database: Database, work: () => Promise<T>): Promise<T> {
  return scope.run(database, work);
}

/** The database `db` currently answers with, if a scope chose one. */
export function scopedDatabase(): Database | undefined {
  return scope.getStore();
}

/**
 * `primary`, except inside `withDatabase`, where every property (and so
 * every query builder) comes from the scope's database instead.
 */
export function routedDatabase(primary: Database): Database {
  return new Proxy(primary, {
    get(target, property) {
      const chosen = scope.getStore() ?? target;
      const value = Reflect.get(chosen, property, chosen);
      return typeof value === 'function' ? value.bind(chosen) : value;
    },
  });
}
