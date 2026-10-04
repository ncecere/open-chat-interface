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
 * Waits until another backend is blocked on a lock while running a statement
 * matching `pattern` (an SQL LIKE pattern), so a test can terminate it in the
 * middle of exactly that statement.
 */
export async function waitForLockWaiter(
  control: ControlSql,
  pattern: string,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await control<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and wait_event_type = 'Lock' and query ilike ${pattern}
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
  timeoutMs = 10_000,
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
