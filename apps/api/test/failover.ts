import postgres from 'postgres';

/**
 * What a database failover does to the application, reproduced on one server
 * (v0.11 design, section 3): every backend connection to the database is
 * terminated from a separate session with `pg_terminate_backend`, so open
 * transactions roll back, session advisory locks are released and every
 * client sees its connection close (SQLSTATE 57P01, then CONNECTION_CLOSED).
 *
 * Live tests each own a throwaway database, so "every backend" means every
 * backend of that database, apart from the control session itself.
 */
export type ControlSql = postgres.Sql | postgres.TransactionSql;

export function controlConnection(connectionString: string): postgres.Sql {
  return postgres(connectionString, { max: 1, onnotice: () => {} });
}

/** Terminates every other backend connected to the current database; returns how many. */
export async function terminateEveryBackend(control: ControlSql): Promise<number> {
  const rows = await control<{ terminated: boolean }[]>`
    select pg_terminate_backend(pid) as terminated
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
  `;
  return rows.filter((row) => row.terminated).length;
}

/**
 * Waits until another backend is blocked by a lock this connection (`control`,
 * inside the transaction that holds it) holds, so a test can terminate it in
 * the middle of the statement it is blocked on. `pattern` (an SQL LIKE
 * pattern for that statement) only labels the failure.
 *
 * Matched with pg_blocking_pids(), not the query text: pg_stat_activity's
 * fields are not read atomically, and a blocked backend was seen still
 * showing its previous statement (`begin`) for the whole wait.
 */
export async function waitForLockWaiter(
  control: ControlSql,
  pattern: string,
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await control<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and pg_backend_pid() = any(pg_blocking_pids(pid))
      limit 1
    `;
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const activity = await control<{ state: string; wait: string | null; query: string }[]>`
    select state, wait_event_type as wait, left(query, 120) as query from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
  `;
  throw new Error(
    `No backend waited on a lock while running ${pattern}: ${JSON.stringify(activity)}`,
  );
}

/** Waits until another backend is running a statement matching `pattern`. */
export async function waitForStatement(
  control: ControlSql,
  pattern: string,
  // Generous: under the parallel coverage run on a loaded host the turn can
  // take several seconds to reach its lock (seen once at 10 s).
  timeoutMs = 20_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await control<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and state = 'active' and query ilike ${pattern}
      limit 1
    `;
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No backend ran ${pattern}`);
}

export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
