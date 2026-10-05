import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MIGRATIONS_FOLDER = join(packageRoot, 'drizzle');
export const DEFAULT_POST_FOLDER = join(packageRoot, 'post');
export const DEFAULT_RELEASE_MANIFEST = join(packageRoot, 'releases.json');

/** A client the checks below can query: a pool, a reserved connection or a transaction. */
export type Queryable = postgres.Sql | postgres.ReservedSql | postgres.TransactionSql;

export interface JournalEntry {
  idx: number;
  tag: string;
  /** Drizzle records this as `created_at` once the migration is applied. */
  when: number;
}

/** The Drizzle journal of a migrations folder. */
export function readJournal(folder: string = DEFAULT_MIGRATIONS_FOLDER): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries.map(({ idx, tag, when }) => ({ idx, tag, when }));
}

export interface ReleaseRequirements {
  /** Post-deploy steps (file names without `.sql`) that must have finished. */
  postSteps?: string[];
  /** Background migrations that must have finished. */
  backgroundMigrations?: string[];
}

export interface ReleaseEntry {
  /** `0.12.0`: the minor release whose migrations start at `firstMigration`. */
  version: string;
  /** Journal tag of the release's first pre-deploy migration. */
  firstMigration: string;
  requires?: ReleaseRequirements;
}

export function readReleaseManifest(file: string = DEFAULT_RELEASE_MANIFEST): ReleaseEntry[] {
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { releases: ReleaseEntry[] };
  return manifest.releases;
}

/** The release a migration belongs to: the last whose first migration is not after it. */
export function releaseOf(
  tag: string,
  journal: JournalEntry[],
  manifest: ReleaseEntry[],
): ReleaseEntry | null {
  const position = new Map(journal.map((entry) => [entry.tag, entry.idx]));
  const idx = position.get(tag);
  if (idx === undefined) return null;
  let found: ReleaseEntry | null = null;
  let foundAt = -1;
  for (const release of manifest) {
    const start = position.get(release.firstMigration);
    if (start !== undefined && start <= idx && start > foundAt) {
      found = release;
      foundAt = start;
    }
  }
  return found;
}

async function relationExists(client: Queryable, name: string): Promise<boolean> {
  const [row] = await client<
    [{ found: boolean }]
  >`select to_regclass(${name}) is not null as found`;
  return row?.found === true;
}

export interface MigrationHistory {
  /** False when the database has never been migrated. */
  migrated: boolean;
  /** `created_at` of every applied migration. */
  applied: number[];
}

/** What `drizzle.__drizzle_migrations` records; empty for a new database. */
export async function migrationHistory(client: Queryable): Promise<MigrationHistory> {
  if (!(await relationExists(client, 'drizzle.__drizzle_migrations')))
    return { migrated: false, applied: [] };
  const rows = await client<{ created_at: string }[]>`
    select created_at::text as created_at from drizzle.__drizzle_migrations order by created_at
  `;
  const applied = rows.map((row) => Number(row.created_at));
  return { migrated: applied.length > 0, applied };
}

/**
 * Bundled migrations Drizzle would apply: those newer than the newest
 * recorded one (Drizzle compares `when` with the latest `created_at`).
 */
export function pendingMigrations(journal: JournalEntry[], history: MigrationHistory) {
  const latest = history.applied.at(-1) ?? Number.NEGATIVE_INFINITY;
  return journal.filter((entry) => entry.when > latest);
}

export interface UnfinishedRequirement {
  kind: 'post-step' | 'background-migration';
  name: string;
  /** The release that needs it. */
  requiredBy: string;
  /** Where it stands: `not applied`, `running`, `paused`, `failed`, `not scheduled`. */
  state: string;
}

/**
 * Work earlier releases left that the pending migrations' releases declare
 * they need (`releases.json`), and is not finished. Empty for a new database:
 * there is no data to backfill, and the steps run with the rest.
 */
export async function unfinishedRequirements(
  client: Queryable,
  options: { migrationsFolder?: string; manifest?: ReleaseEntry[] } = {},
): Promise<UnfinishedRequirement[]> {
  const journal = readJournal(options.migrationsFolder);
  const manifest = options.manifest ?? readReleaseManifest();
  const history = await migrationHistory(client);
  if (!history.migrated) return [];
  const releases = new Map<string, ReleaseEntry>();
  for (const entry of pendingMigrations(journal, history)) {
    const release = releaseOf(entry.tag, journal, manifest);
    if (release?.requires) releases.set(release.version, release);
  }
  if (releases.size === 0) return [];

  const hasPost = await relationExists(client, 'public.oci_post_migration');
  const hasBackground = await relationExists(client, 'public.background_migration');
  const unfinished: UnfinishedRequirement[] = [];
  for (const release of releases.values()) {
    for (const name of release.requires?.postSteps ?? []) {
      const [row] = hasPost
        ? await client<[{ finished: boolean }?]>`
            select finished_at is not null as finished from oci_post_migration where name = ${name}`
        : [];
      if (!row?.finished) {
        unfinished.push({
          kind: 'post-step',
          name,
          requiredBy: release.version,
          state: row ? 'started, not finished' : 'not applied',
        });
      }
    }
    for (const name of release.requires?.backgroundMigrations ?? []) {
      const [row] = hasBackground
        ? await client<[{ status: string }?]>`
            select status from background_migration where name = ${name}`
        : [];
      if (row?.status !== 'finished') {
        unfinished.push({
          kind: 'background-migration',
          name,
          requiredBy: release.version,
          state: row?.status ?? 'not scheduled',
        });
      }
    }
  }
  return unfinished;
}

export function describeRequirement(requirement: UnfinishedRequirement): string {
  const kind = requirement.kind === 'post-step' ? 'post-deploy step' : 'background migration';
  return `${kind} "${requirement.name}" (${requirement.state})`;
}

/** Thrown by the migrator instead of applying a release whose prerequisites are unfinished. */
export class UnfinishedRequirementsError extends Error {
  override name = 'UnfinishedRequirementsError';
  readonly unfinished: UnfinishedRequirement[];

  constructor(unfinished: UnfinishedRequirement[]) {
    const releases = [...new Set(unfinished.map((item) => item.requiredBy))].join(', ');
    super(
      `Release ${releases} needs earlier work finished before its database migrations can run: ` +
        `${unfinished.map(describeRequirement).join('; ')}. ` +
        'Finish it on the release now running: run `migrate --post` for post-deploy steps and ' +
        'scheduling, and let background migrations finish (System health, Upgrades, shows ' +
        'their progress). If the database skipped a release, upgrade to that release first. ' +
        'Nothing was changed.',
    );
    this.unfinished = unfinished;
  }
}
