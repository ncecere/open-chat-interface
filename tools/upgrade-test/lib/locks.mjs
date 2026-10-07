import { psql, sleep } from '../lib.mjs';
import { env, MIGRATION_LOCK, POST_MIGRATION_LOCK } from './context.mjs';

/* ------------------------------------------------------------------------ */
/* Lock monitor                                                               */
/* ------------------------------------------------------------------------ */

export function startLockMonitor(currentPhase, intervalMs = 1000) {
  // The migrators' own sessions wait by design (a concurrent index build
  // waits for every older transaction); what matters is who waits on them.
  const keys = [MIGRATION_LOCK, POST_MIGRATION_LOCK]
    .map((key) => `(${Number(key >> 32n)}, ${Number(key & 0xffffffffn)})`)
    .join(', ');
  const query = `
    select a.pid,
           (extract(epoch from clock_timestamp() - a.query_start) * 1000)::bigint,
           left(regexp_replace(a.query, '\\s+', ' ', 'g'), 120),
           coalesce((select left(regexp_replace(b.query, '\\s+', ' ', 'g'), 120)
                       from pg_stat_activity b
                      where b.pid = (pg_blocking_pids(a.pid))[1]), '')
      from pg_stat_activity a
     where a.wait_event_type = 'Lock' and a.backend_type = 'client backend'
       and not exists (select 1 from pg_locks l where l.pid = a.pid and l.locktype = 'advisory'
                        and (l.classid::bigint, l.objid::bigint) in (${keys}) and l.granted);`;
  const waits = new Map();
  let running = true;
  const loop = (async () => {
    while (running) {
      const t0 = Date.now();
      try {
        const out = await psql(query, env);
        for (const line of out.trim().split('\n').filter(Boolean)) {
          const [pid, waited, q, blocker] = line.split('\t');
          const key = `${pid}:${q}`;
          const waitedMs = Number(waited);
          const prior = waits.get(key);
          if (!prior || prior.waitedMs < waitedMs) {
            waits.set(key, {
              waitedMs,
              query: q,
              blocker,
              phase: currentPhase(),
            });
          }
        }
      } catch {}
      await sleep(Math.max(0, intervalMs - (Date.now() - t0)));
    }
  })();
  return async () => {
    running = false;
    await loop;
    const top = [...waits.values()].sort((a, b) => b.waitedMs - a.waitedMs).slice(0, 15);
    return {
      intervalMs,
      samples: waits.size,
      maxWaitMs: top[0]?.waitedMs ?? 0,
      top,
    };
  };
}
