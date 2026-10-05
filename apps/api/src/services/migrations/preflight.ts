import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BackgroundMigrationDefinition,
  backgroundMigrations,
  DEFAULT_MIGRATIONS_FOLDER,
  DEFAULT_POST_FOLDER,
  type IndexBuild,
  loadSqlParser,
  migrationHistory,
  type ParsedStatement,
  parseStatements,
  pendingMigrations,
  postStepStates,
  type ReleaseEntry,
  readJournal,
  readReleaseManifest,
  releaseOf,
  statementCost,
  tablesCreated,
  tablesTouched,
  unfinishedRequirements,
} from '@oci/db';
import type {
  IndexEstimate,
  PendingMigration,
  PostStepSummary,
  StatementEstimate,
  TableEstimate,
  UpgradeMode,
  UpgradeReport,
} from '@oci/shared';
import type postgres from 'postgres';
import { APP_VERSION } from '../../version.js';
import { listBackgroundMigrations } from './background-admin.js';

/**
 * The upgrade preflight (v0.11 design, section 6): what upgrading this
 * database to the bundled release involves, from `node
 * dist/scripts/upgrade-check.js` in the new image before an upgrade, and from
 * System health, Upgrades, on a running release.
 *
 * Every pending statement is parsed (libpg-query, as the migration linter
 * does) for the tables it touches and how its cost grows with them; sizes
 * come from `pg_class.reltuples` and `pg_total_relation_size`. A statement
 * whose cost grows with a table that is not small makes the upgrade need a
 * window, because pre-deploy migrations run in one transaction while the
 * previous release serves. Post-deploy steps and background migrations never
 * do: they run while OCI serves, without blocking writes.
 *
 * Free disk space cannot be read through SQL, so the report states what an
 * index build needs instead.
 */

/** A table this size or smaller makes any pre-deploy statement on it take seconds at most. */
export const SMALL_TABLE_ROWS = 10_000;
export const SMALL_TABLE_BYTES = 64 * 1024 * 1024;

export interface PreflightOptions {
  migrationsFolder?: string;
  postFolder?: string;
  manifest?: ReleaseEntry[];
  definitions?: BackgroundMigrationDefinition[];
  version?: string;
}

function shorten(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function describeTable(table: TableEstimate): string {
  const rows = table.rows === null ? 'rows unknown' : `${table.rows.toLocaleString('en')} rows`;
  return `${table.name} (${rows}, ${formatBytes(table.bytes ?? 0)})`;
}

async function tableEstimates(
  client: postgres.Sql,
  names: string[],
): Promise<Map<string, TableEstimate>> {
  const estimates = new Map<string, TableEstimate>();
  for (const name of names) estimates.set(name, { name, exists: false, rows: null, bytes: null });
  if (names.length === 0) return estimates;
  const rows = await client<{ name: string; rows: string | null; bytes: string }[]>`
    select n.nspname || '.' || c.relname as name,
      -- -1 means never analysed: known empty when its heap is, else unknown
      -- (relpages is not updated by inserts, so it cannot tell).
      case when c.reltuples >= 0 then c.reltuples::bigint
        when pg_relation_size(c.oid) = 0 then 0 end as rows,
      pg_total_relation_size(c.oid) as bytes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname || '.' || c.relname = any(${client.array(names)}::text[])
      and c.relkind in ('r', 'p', 'm')
  `;
  for (const row of rows) {
    estimates.set(row.name, {
      name: row.name,
      exists: true,
      rows: row.rows === null ? null : Number(row.rows),
      bytes: Number(row.bytes),
    });
  }
  return estimates;
}

function isSmall(table: TableEstimate): boolean {
  return (table.rows ?? 0) <= SMALL_TABLE_ROWS && (table.bytes ?? 0) <= SMALL_TABLE_BYTES;
}

const COST_PHRASE: Record<string, string> = {
  scan: 'reads every row while blocking writes to',
  rewrite: 'rewrites, under an exclusive lock,',
  index: 'builds an index while blocking writes to',
  data: 'changes existing rows of',
  lock: 'locks',
  'concurrent-index': 'cannot run inside the migration transaction; it builds an index on',
};

/**
 * Estimates one statement. `created` holds tables created earlier in the
 * same run, which are new and empty when the statement runs.
 */
function estimateStatement(
  statement: ParsedStatement,
  stats: Map<string, TableEstimate>,
  created: Set<string>,
  phase: 'pre' | 'post',
): StatementEstimate {
  const cost = statementCost(statement);
  const tables = tablesTouched(statement).map(
    (name) => stats.get(name) ?? { name, exists: false, rows: null, bytes: null },
  );
  const affected = tables.filter((table) => table.exists && !created.has(table.name));
  let fast = true;
  let reason: string | null = null;
  if (phase === 'pre' && cost !== 'catalog') {
    const large = affected.filter((table) => !isSmall(table));
    if (cost === 'lock' || cost === 'concurrent-index') {
      fast = false;
    } else if (large.length > 0) {
      fast = false;
    }
    if (!fast) {
      const named = (large.length > 0 ? large : affected).map(describeTable).join(', ');
      reason = `${COST_PHRASE[cost]} ${named || tables.map((t) => t.name).join(', ')}`;
    }
  }
  return { summary: shorten(statement.text), cost, tables, fast, reason };
}

function readStatements(folder: string, tag: string): ParsedStatement[] | null {
  try {
    return parseStatements(readFileSync(join(folder, `${tag}.sql`), 'utf8'));
  } catch {
    return null;
  }
}

/** The planner's estimate of the rows a partial index's predicate matches, or null. */
async function predicateRows(client: postgres.Sql, index: IndexBuild): Promise<number | null> {
  const [schemaName, tableName] = index.table.split('.') as [string, string];
  const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
  try {
    // EXPLAIN plans without running anything. The predicate is from a bundled
    // post-deploy file, never from a request.
    const [row] = await client.unsafe<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }[]>(
      `explain (format json) select 1 from ${quote(schemaName)}.${quote(tableName)} where ${index.predicate}`,
    );
    const rows = row?.['QUERY PLAN']?.[0]?.Plan?.['Plan Rows'];
    return typeof rows === 'number' ? rows : null;
  } catch {
    return null;
  }
}

async function estimateIndex(
  client: postgres.Sql,
  index: IndexBuild,
  table: TableEstimate,
): Promise<IndexEstimate> {
  const [existing] = index.name
    ? await client<{ valid: boolean }[]>`
        select i.indisvalid as valid from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_index i on i.indexrelid = c.oid
        where n.nspname = ${index.schema} and c.relname = ${index.name}`
    : [];
  const [schemaName, tableName] = index.table.split('.') as [string, string];
  let estimatedBytes: number | null = null;
  let sizedFromStatistics = false;
  // A partial index holds only the rows its predicate matches: ask the planner how many.
  const rows = index.predicate ? await predicateRows(client, index) : table.rows;
  if (index.method === 'btree' && !index.expression && index.columns.length > 0 && rows !== null) {
    // Width per key column: the planner's statistics, else the type's fixed length.
    const widths = await client<{ width: number }[]>`
      select coalesce(s.avg_width, case when t.typlen > 0 then t.typlen else 32 end)::integer as width
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid
      left join pg_stats s on s.schemaname = n.nspname and s.tablename = c.relname and s.attname = a.attname
      where n.nspname = ${schemaName} and c.relname = ${tableName}
        and a.attname = any(${client.array(index.columns)}::text[])
    `;
    const keyBytes = widths.reduce((sum, row) => sum + row.width, 0);
    // Index tuple header (8) + key padded to 8 + line pointer (4); 90 % fill; ~2 % inner pages.
    const perRow = 8 + Math.ceil(keyBytes / 8) * 8 + 4;
    // A btree has at least a metapage and a root page.
    estimatedBytes = Math.max(16_384, Math.round(((rows * perRow) / 0.9) * 1.02));
    sizedFromStatistics = true;
  } else if (table.bytes !== null) {
    estimatedBytes = Math.round(table.bytes * 0.3);
  }
  return {
    name: index.name,
    table: index.table,
    estimatedBytes,
    sizedFromStatistics,
    invalidExists: existing ? !existing.valid : false,
    exists: existing ? existing.valid : false,
  };
}

function minor(version: string | null): [number, number] | null {
  const match = version?.match(/^v?(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** The report for this database and the bundled release. */
export async function upgradeReport(
  client: postgres.Sql,
  options: PreflightOptions = {},
): Promise<UpgradeReport> {
  await loadSqlParser();
  const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const postFolder = options.postFolder ?? DEFAULT_POST_FOLDER;
  const manifest = options.manifest ?? readReleaseManifest();
  const definitions = options.definitions ?? backgroundMigrations();
  const version = options.version ?? APP_VERSION;

  const journal = readJournal(migrationsFolder);
  const history = await migrationHistory(client);
  const bundledLatest = journal.at(-1) ?? null;
  const latestApplied = history.applied.at(-1) ?? null;
  const unknownNewer = history.applied.filter(
    (when) => bundledLatest !== null && when > bundledLatest.when,
  ).length;
  const latestEntry =
    latestApplied === null ? null : (journal.find((entry) => entry.when === latestApplied) ?? null);
  const databaseRelease = latestEntry
    ? (releaseOf(latestEntry.tag, journal, manifest)?.version ?? null)
    : null;

  // Pre-deploy: parse everything pending, then look the tables up once.
  const pending = pendingMigrations(journal, history);
  const parsed = pending.map((entry) => ({
    entry,
    statements: readStatements(migrationsFolder, entry.tag),
  }));
  const postStates = await postStepStates(client, postFolder);
  const names = new Set<string>();
  for (const { statements } of parsed)
    for (const statement of statements ?? [])
      for (const name of tablesTouched(statement)) names.add(name);
  for (const state of postStates)
    for (const name of tablesTouched(state.step.statement)) names.add(name);
  const stats = await tableEstimates(client, [...names]);

  const created = new Set<string>();
  const preDeploy: PendingMigration[] = parsed.map(({ entry, statements }) => {
    const estimates: StatementEstimate[] = statements
      ? statements.map((statement) => {
          const estimate = estimateStatement(statement, stats, created, 'pre');
          for (const name of tablesCreated(statement))
            if (!stats.get(name)?.exists) created.add(name);
          return estimate;
        })
      : [
          {
            summary: `${entry.tag}.sql`,
            cost: 'catalog',
            tables: [],
            fast: false,
            reason: 'could not be read or parsed',
          },
        ];
    return {
      tag: entry.tag,
      release: releaseOf(entry.tag, journal, manifest)?.version ?? null,
      statements: estimates,
      fast: estimates.every((estimate) => estimate.fast),
    };
  });

  const postDeploy: PostStepSummary[] = [];
  for (const state of postStates) {
    const statement = estimateStatement(state.step.statement, stats, new Set(), 'post');
    const table = state.step.index ? stats.get(state.step.index.table) : undefined;
    postDeploy.push({
      name: state.name,
      release: state.release,
      state: state.state,
      attempts: state.attempts,
      lastError: state.lastError,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      durationMs: state.durationMs,
      statement,
      index:
        state.step.index && table ? await estimateIndex(client, state.step.index, table) : null,
    });
  }

  const background = await listBackgroundMigrations(client, definitions);
  const requirements = await unfinishedRequirements(client, { migrationsFolder, manifest });
  const invalid = await client<{ name: string }[]>`
    select n.nspname || '.' || c.relname as name
    from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not i.indisvalid and n.nspname not in ('pg_catalog', 'information_schema')
    order by 1
  `;
  const toBuild = postDeploy.filter(
    (step) => step.state !== 'finished' && step.index && !step.index.exists,
  );

  const report: UpgradeReport = {
    generatedAt: new Date().toISOString(),
    bundled: {
      version,
      latestMigration: bundledLatest?.tag ?? null,
      migrations: journal.length,
      postSteps: postStates.length,
      backgroundMigrations: definitions.length,
    },
    database: {
      fresh: !history.migrated,
      latestMigration: latestEntry?.tag ?? null,
      release: databaseRelease,
      applied: history.applied.length,
      unknownNewer,
    },
    preDeploy,
    postDeploy,
    background,
    requirements,
    indexes: {
      toBuild: toBuild.length,
      estimatedBytes: toBuild.reduce((sum, step) => sum + (step.index?.estimatedBytes ?? 0), 0),
      invalid: invalid.map((row) => row.name),
    },
    verdict: { mode: 'current', summary: '', reasons: [] },
  };
  report.verdict = verdictOf(report);
  return report;
}

/** Whether the upgrade can be rolling, needs a window, or cannot run yet, and why. */
export function verdictOf(report: Omit<UpgradeReport, 'verdict'>): UpgradeReport['verdict'] {
  const reasons: string[] = [];
  let mode: UpgradeMode = 'current';
  const raise = (to: UpgradeMode) => {
    const order: UpgradeMode[] = ['current', 'rolling', 'window', 'blocked'];
    if (order.indexOf(to) > order.indexOf(mode)) mode = to;
  };
  const { database, bundled } = report;

  if (database.unknownNewer > 0) {
    raise('blocked');
    reasons.push(
      `The database has ${database.unknownNewer} migration(s) this release does not include: a newer release migrated it. Run that release (or newer); downgrading is not supported.`,
    );
  }
  for (const requirement of report.requirements) {
    raise('blocked');
    const kind = requirement.kind === 'post-step' ? 'Post-deploy step' : 'Background migration';
    reasons.push(
      `${kind} ${requirement.name} must finish before ${requirement.requiredBy}'s migrations can run (now: ${requirement.state}). Finish it on the release now running.`,
    );
  }

  const pendingStatements = report.preDeploy.flatMap((migration) =>
    migration.statements.map((statement) => ({ migration, statement })),
  );
  if (database.fresh) {
    raise('rolling');
    reasons.push('A new database: `migrate` creates the schema.');
  } else if (report.preDeploy.length > 0) {
    raise('rolling');
    const slow = pendingStatements.filter(({ statement }) => !statement.fast);
    for (const { migration, statement } of slow) {
      raise('window');
      reasons.push(
        `${migration.tag} ${statement.reason ?? 'grows with table size'}: while it runs, the previous release cannot write those tables.`,
      );
    }
    const from = minor(database.release);
    const to = minor(bundled.version);
    if (from && to && (to[0] > from[0] || to[1] - from[1] > 1)) {
      raise('window');
      reasons.push(
        `The schema is at ${database.release}, more than one minor release behind ${bundled.version}: only the previous minor is supported without downtime; upgrade in a window, or through each minor release.`,
      );
    }
    if (slow.length === 0) {
      reasons.push(
        `${report.preDeploy.length} pre-deploy migration(s), every statement a catalog change or on a new or small table: safe while the previous release serves.`,
      );
    }
  }

  const postPending = report.postDeploy.filter((step) => step.state !== 'finished');
  if (postPending.length > 0) {
    raise('rolling');
    const indexBytes = report.indexes.estimatedBytes;
    reasons.push(
      `${postPending.length} post-deploy step(s) to run with \`migrate --post\` once every replica runs ${bundled.version}${
        report.indexes.toBuild > 0
          ? `; ${report.indexes.toBuild} index(es) to build, about ${formatBytes(indexBytes)}: keep at least ${formatBytes(indexBytes * 2)} free while they build (the sort can use as much again in temporary files)`
          : ''
      }.`,
    );
  }
  const unscheduled = report.background.filter((item) => item.status === 'not_scheduled');
  const unfinished = report.background.filter(
    (item) => item.bundled && !['finished', 'not_scheduled'].includes(item.status),
  );
  if (unscheduled.length > 0) {
    raise('rolling');
    reasons.push(
      `${unscheduled.length} background migration(s) to be scheduled by \`migrate --post\`; they run while OCI serves.`,
    );
  }
  if (unfinished.length > 0) {
    reasons.push(
      `${unfinished.length} background migration(s) in progress (${unfinished.map((item) => `${item.name}: ${item.status}`).join(', ')}).`,
    );
  }
  if (report.indexes.invalid.length > 0) {
    reasons.push(
      `INVALID index(es), left by interrupted concurrent builds: ${report.indexes.invalid.join(', ')}. \`migrate --post\` rebuilds those its steps create.`,
    );
  }

  const summary = {
    current: 'Up to date: nothing to migrate.',
    rolling:
      report.preDeploy.length > 0
        ? 'Rolling upgrade: run `migrate`, replace replicas one at a time, then run `migrate --post`.'
        : postPending.length > 0 || unscheduled.length > 0
          ? 'Run `migrate --post`: the release is deployed and its post-deploy work is waiting.'
          : 'Nothing to migrate.',
    window:
      'Needs a maintenance window: some pre-deploy work blocks writes for longer than a rolling upgrade allows.',
    blocked: 'Cannot upgrade this database with this release yet.',
  }[mode];
  return { mode, summary, reasons };
}
