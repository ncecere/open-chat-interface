import { and, desc, eq, inArray, schema, sql } from '@oci/db';
import { db } from '../../db/index.js';
import {
  cosineDistance,
  pgvectorInfo,
  validDimensions,
  vectorLiteral,
  vectorType,
} from '../embeddings/storage.js';
import {
  type EmbeddingConfig,
  type FailureSummary,
  type FillProgress,
  type Generation,
  GenerationStateError,
  type PassageRef,
  type PassageVector,
  type PendingPassage,
  type StorageState,
  type TransactionExecutor,
  type VectorHit,
  type VectorScope,
  VectorScopeError,
  type VectorStore,
  type VectorStoreHealth,
} from './types.js';

/**
 * The PostgreSQL + pgvector vector store (v0.11 design, section 8).
 *
 * Each generation's vectors are in their own table, created at runtime (the
 * `vector(n)` column needs the extension and the model's size):
 * `project_file_embedding` for generation 1, the name v0.10 created and still
 * reads and writes during a rolling upgrade, and `project_file_embedding_g<n>`
 * after it. Every table has the same shape and a foreign key to its passage
 * with ON DELETE CASCADE, so deleting a passage (and so its file, project or
 * owner, which cascade to it) removes its vectors from every generation in the
 * deleting transaction, whoever deletes it: this release, the previous one
 * during an upgrade, retention, trash purge or account deletion.
 *
 * Searches are exact scans of one person's project (fast enough at the
 * measured scale: 18 to 20 ms for the largest project at `medium`, design
 * section 7), filtered here, never by the caller.
 */

/** The table the previous release uses, kept as generation 1's. */
export const LEGACY_EMBEDDING_TABLE = 'project_file_embedding';
const TABLE_NAME = /^project_file_embedding(_g[1-9][0-9]*)?$/;
/** The lock v0.10's `ensureEmbeddingTable` takes, so both releases serialise table changes. */
const STORAGE_LOCK = 'oci:embeddings:storage';
const GENERATION_LOCK = 'oci:embeddings:generations';
/** Window for the fill rate shown to administrators. */
export const RATE_WINDOW_MINUTES = 10;
/**
 * Creating or dropping a vector table locks `project_file_chunk` briefly (its
 * foreign key). Never wait long for that: a busy moment is retried next tick.
 */
const DDL_LOCK_TIMEOUT = '2s';
const MAX_ERROR_CHARS = 500;
const MINUTE_MS = 60_000;

/** Backoff after a file's n-th failure: 5, 10, 20 ... minutes, at most six hours. */
export function failureBackoffMs(failures: number): number {
  return Math.min(5 * MINUTE_MS * 2 ** Math.max(0, failures - 1), 6 * 60 * MINUTE_MS);
}

export function generationTableName(id: number): string {
  return id === 1 ? LEGACY_EMBEDDING_TABLE : `${LEGACY_EMBEDDING_TABLE}_g${id}`;
}

/** Identifies the vectors one configuration produces; see `embeddingModelKey`. */
export function configKey(config: Pick<EmbeddingConfig, 'providerId' | 'modelId' | 'dimensions'>) {
  return `${config.providerId}/${config.modelId}/${config.dimensions}`;
}

/** The table as an identifier, after checking it is one of ours (never free text). */
function vectorTable(name: string) {
  if (!TABLE_NAME.test(name)) throw new Error(`Not an embedding table: ${name}`);
  return sql.identifier(name);
}

/** A bound text[] literal: one parameter per element, never spliced as SQL. */
function textArray(values: string[]) {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/** Project files that count: in a project, uploaded, not in the trash. */
const LIVE_FILE = sql`a.project_id is not null and a.upload_pending = false and a.deleted_at is null`;

const G = schema.embeddingGeneration;
const F = schema.embeddingGenerationFailure;

function toGeneration(row: typeof G.$inferSelect): Generation {
  const { updatedAt: _updatedAt, ...generation } = row;
  return { ...generation, inputPriceMicros: row.inputPriceMicros ?? null };
}

function assertScope(scope: VectorScope): void {
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!scope || !text(scope.personId) || !text(scope.projectId)) {
    throw new VectorScopeError('A vector search needs a person and a project');
  }
  if (
    scope.fileIds !== undefined &&
    (!Array.isArray(scope.fileIds) || !scope.fileIds.every((id) => typeof id === 'string'))
  ) {
    throw new VectorScopeError('File ids must be a list of ids');
  }
}

/** The person-and-project filter, on `e` (vectors) joined to `a` (attachment). */
function scopeFilter(scope: VectorScope) {
  assertScope(scope);
  return sql`a.user_id = ${scope.personId}
    and a.project_id = ${scope.projectId}
    and a.upload_pending = false
    and a.deleted_at is null
    ${scope.fileIds ? sql`and e.attachment_id = any(${textArray(scope.fileIds)})` : sql``}`;
}

interface StorageInfo {
  /** Schema of the pgvector extension, or null when it is not enabled. */
  schema: string | null;
  /** Size of the table's vector column, or null when the table does not exist. */
  dimensions: number | null;
}

async function storageInfo(executor: TransactionExecutor, tableName: string): Promise<StorageInfo> {
  const [row] = await executor.execute<{ schema: string | null; dimensions: number | null }>(sql`
    select n.nspname as schema,
           (select a.atttypmod from pg_attribute a
            where a.attrelid = to_regclass(${tableName})
              and a.attname = 'embedding' and not a.attisdropped) as dimensions
    from (select 1) as one
    left join pg_extension e on e.extname = 'vector'
    left join pg_namespace n on n.oid = e.extnamespace
  `);
  return {
    schema: row?.schema ?? null,
    dimensions: row?.dimensions == null ? null : Number(row.dimensions),
  };
}

async function lock(executor: TransactionExecutor, name: string) {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${name}))`);
}

export class PgvectorStore implements VectorStore {
  readonly kind = 'pgvector' as const;

  async health(): Promise<VectorStoreHealth> {
    const info = await pgvectorInfo();
    return { kind: 'pgvector', state: info.state, version: info.version };
  }

  async listGenerations(): Promise<Generation[]> {
    return (await db.select().from(G).orderBy(G.id)).map(toGeneration);
  }

  async liveGenerations() {
    const rows = await db
      .select()
      .from(G)
      .where(inArray(G.state, ['current', 'filling']));
    const find = (state: string) => {
      const row = rows.find((candidate) => candidate.state === state);
      return row ? toGeneration(row) : null;
    };
    return { current: find('current'), filling: find('filling') };
  }

  async createGeneration(
    config: EmbeddingConfig,
    options: { state: 'current' | 'filling'; createdBy?: string | null },
  ): Promise<Generation> {
    if (!validDimensions(config.dimensions)) throw new RangeError('Invalid embedding dimensions');
    const modelKey = configKey(config);
    return db.transaction(async (tx) => {
      await lock(tx, GENERATION_LOCK);
      const [taken] = await tx.select({ id: G.id }).from(G).where(eq(G.state, options.state));
      if (taken) {
        throw new GenerationStateError(`Generation ${taken.id} is already ${options.state}`);
      }
      const changes = {
        state: options.state,
        inputPriceMicros: config.inputPriceMicros,
        createdBy: options.createdBy ?? null,
        updatedAt: new Date(),
      };
      // The same configuration, retired or cancelled but not dropped yet: its
      // vectors are still valid, so only what is missing is embedded again.
      const [reusable] = await tx
        .select({ id: G.id })
        .from(G)
        .where(and(eq(G.modelKey, modelKey), inArray(G.state, ['retired', 'cancelled'])))
        .orderBy(desc(G.id))
        .limit(1);
      if (reusable) {
        const [row] = await tx
          .update(G)
          .set({ ...changes, retiredAt: null, dropAfter: null, switchedAt: null })
          .where(eq(G.id, reusable.id))
          .returning();
        return toGeneration(row!);
      }
      const [{ next } = { next: 1 }] = await tx
        .select({ next: sql<number>`coalesce(max(${G.id}), 0)::int + 1` })
        .from(G);
      const id = Number(next);
      const [row] = await tx
        .insert(G)
        .values({
          id,
          tableName: generationTableName(id),
          providerId: config.providerId,
          modelId: config.modelId,
          dimensions: config.dimensions,
          modelKey,
          ...changes,
        })
        .returning();
      return toGeneration(row!);
    });
  }

  async setPrice(generationId: number, inputPriceMicros: number | null): Promise<void> {
    await db
      .update(G)
      .set({ inputPriceMicros, updatedAt: new Date() })
      .where(and(eq(G.id, generationId), inArray(G.state, ['current', 'filling'])));
  }

  async ensureStorage(
    generation: Generation,
    options: { replaceMismatched?: boolean } = {},
  ): Promise<'created' | 'recreated' | 'ready' | 'mismatch'> {
    if (!validDimensions(generation.dimensions)) {
      throw new RangeError('Invalid embedding dimensions');
    }
    const table = vectorTable(generation.tableName);
    return db.transaction(async (tx) => {
      await lock(tx, STORAGE_LOCK);
      const info = await storageInfo(tx, generation.tableName);
      if (!info.schema) throw new Error('The pgvector extension is not enabled');
      if (info.dimensions === generation.dimensions) return 'ready';
      if (info.dimensions !== null && !options.replaceMismatched) return 'mismatch';
      // Under the storage lock, which `dropStorage` holds until it commits: a
      // generation cancelled or dropped meanwhile gets no table again.
      const [row] = await tx.select({ state: G.state }).from(G).where(eq(G.id, generation.id));
      if (row && row.state !== 'current' && row.state !== 'filling') {
        throw new GenerationStateError(`Generation ${generation.id} is ${row.state}`);
      }
      await tx.execute(sql.raw(`set local lock_timeout = '${DDL_LOCK_TIMEOUT}'`));
      if (info.dimensions !== null) await tx.execute(sql`drop table ${table}`);
      await tx.execute(sql`
        create table ${table} (
          attachment_id text not null,
          ordinal integer not null,
          model_key text not null,
          embedding ${vectorType(info.schema, generation.dimensions)} not null,
          embedded_at timestamp with time zone not null default now(),
          constraint ${sql.identifier(`${generation.tableName}_pk`)}
            primary key (attachment_id, ordinal),
          constraint ${sql.identifier(`${generation.tableName}_chunk_fk`)}
            foreign key (attachment_id, ordinal)
            references project_file_chunk (attachment_id, ordinal) on delete cascade
        )
      `);
      return info.dimensions === null ? 'created' : 'recreated';
    });
  }

  async storageState(generation: Generation): Promise<StorageState> {
    const info = await storageInfo(db, generation.tableName);
    if (!info.schema) return 'unavailable';
    if (info.dimensions === null) return 'missing';
    return info.dimensions === generation.dimensions ? 'ready' : 'mismatch';
  }

  /** The extension's schema when the generation's table is there at its size. */
  private async readySchema(generation: Generation): Promise<string | null> {
    if (generation.state === 'dropped') return null;
    const info = await storageInfo(db, generation.tableName);
    return info.schema && info.dimensions === generation.dimensions ? info.schema : null;
  }

  async fillProgress(generation: Generation): Promise<FillProgress> {
    const ready = (await this.readySchema(generation)) !== null;
    const table = vectorTable(generation.tableName);
    const [row] = await db.execute<{ total: number; embedded: number; recent: number }>(sql`
      select
        (select count(*) from project_file_chunk c
           join attachment a on a.id = c.attachment_id
          where ${LIVE_FILE})::int as total,
        ${
          ready
            ? sql`(select count(*) from ${table} e
                     join attachment a on a.id = e.attachment_id
                    where e.model_key = ${generation.modelKey} and ${LIVE_FILE})::int`
            : sql`0`
        } as embedded,
        ${
          ready
            ? sql`(select count(*) from ${table} e
                    where e.model_key = ${generation.modelKey}
                      and e.embedded_at > now() - make_interval(mins => ${RATE_WINDOW_MINUTES}))::int`
            : sql`0`
        } as recent
    `);
    return {
      total: Number(row?.total ?? 0),
      embedded: Number(row?.embedded ?? 0),
      perMinute: Number(row?.recent ?? 0) / RATE_WINDOW_MINUTES,
    };
  }

  async covers(generation: Generation): Promise<boolean> {
    if ((await this.readySchema(generation)) === null) return false;
    const [row] = await db.execute<{ missing: boolean }>(sql`
      select exists (
        select 1 from project_file_chunk c
        join attachment a on a.id = c.attachment_id
        left join ${vectorTable(generation.tableName)} e
          on e.attachment_id = c.attachment_id and e.ordinal = c.ordinal
         and e.model_key = ${generation.modelKey}
        where e.attachment_id is null and ${LIVE_FILE}
      ) as missing
    `);
    return row?.missing === false;
  }

  async switchTo(
    generationId: number,
    options: {
      graceMs: number;
      forced: boolean;
      alsoInTransaction?: (tx: TransactionExecutor, next: Generation) => Promise<void>;
    },
  ) {
    const graceMs = Math.max(0, Math.round(options.graceMs));
    return db.transaction(async (tx) => {
      await lock(tx, GENERATION_LOCK);
      const rows = await tx
        .select()
        .from(G)
        .where(inArray(G.state, ['current', 'filling']))
        .for('update');
      const target = rows.find((row) => row.id === generationId && row.state === 'filling');
      if (!target) {
        throw new GenerationStateError(`Generation ${generationId} is not being filled`);
      }
      const previous = rows.find((row) => row.state === 'current');
      let retired: Generation | null = null;
      if (previous) {
        const [row] = await tx
          .update(G)
          .set({
            state: 'retired',
            retiredAt: sql`now()`,
            dropAfter: sql`now() + make_interval(secs => ${graceMs / 1000})`,
            updatedAt: sql`now()`,
          })
          .where(eq(G.id, previous.id))
          .returning();
        retired = toGeneration(row!);
      }
      const [row] = await tx
        .update(G)
        .set({
          state: 'current',
          switchedAt: sql`now()`,
          switchForced: options.forced,
          updatedAt: sql`now()`,
        })
        .where(eq(G.id, target.id))
        .returning();
      const current = toGeneration(row!);
      await options.alsoInTransaction?.(tx, current);
      return { current, retired };
    });
  }

  async cancel(generationId: number): Promise<Generation | null> {
    return db.transaction(async (tx) => {
      await lock(tx, GENERATION_LOCK);
      const [row] = await tx
        .update(G)
        .set({ state: 'cancelled', dropAfter: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(G.id, generationId), eq(G.state, 'filling')))
        .returning();
      return row ? toGeneration(row) : null;
    });
  }

  async dropStorage(
    generation: Generation,
    options: { previousReleaseGone: boolean },
  ): Promise<boolean> {
    // v0.10 replicas read and write generation 1's table, and would create it
    // again empty (and embed every passage into it) if it went while they run.
    if (generation.tableName === LEGACY_EMBEDDING_TABLE && !options.previousReleaseGone) {
      return false;
    }
    const table = vectorTable(generation.tableName);
    return db.transaction(async (tx) => {
      await lock(tx, GENERATION_LOCK);
      await lock(tx, STORAGE_LOCK);
      const [row] = await tx
        .select({
          state: G.state,
          due: sql<boolean>`${G.state} = 'cancelled'
            or (${G.state} = 'retired' and ${G.dropAfter} <= now())`,
        })
        .from(G)
        .where(eq(G.id, generation.id))
        .for('update');
      if (!row?.due) return false;
      await tx.execute(sql.raw(`set local lock_timeout = '${DDL_LOCK_TIMEOUT}'`));
      await tx.execute(sql`drop table if exists ${table}`);
      await tx.delete(schema.embeddingGenerationFailure).where(eq(F.generationId, generation.id));
      await tx
        .update(G)
        .set({ state: 'dropped', droppedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(G.id, generation.id));
      return true;
    });
  }

  async pendingPassages(
    generation: Generation,
    options: { limit: number; attachmentId?: string; after?: PassageRef },
  ): Promise<PendingPassage[]> {
    if ((await this.readySchema(generation)) === null) return [];
    const after = options.after;
    const rows = await db.execute<{
      attachment_id: string;
      user_id: string;
      organization_id: string;
      ordinal: number;
      content: string;
    }>(sql`
      select c.attachment_id, a.user_id, a.organization_id, c.ordinal, c.content
      from project_file_chunk c
      join attachment a on a.id = c.attachment_id
      left join ${vectorTable(generation.tableName)} e
        on e.attachment_id = c.attachment_id and e.ordinal = c.ordinal
       and e.model_key = ${generation.modelKey}
      left join embedding_generation_failure f
        on f.generation_id = ${generation.id} and f.attachment_id = c.attachment_id
      where e.attachment_id is null
        and ${LIVE_FILE}
        and (f.retry_at is null or f.retry_at <= now())
        ${options.attachmentId ? sql`and c.attachment_id = ${options.attachmentId}` : sql``}
        ${after ? sql`and (c.attachment_id, c.ordinal) > (${after.attachmentId}, ${after.ordinal}::int)` : sql``}
      ${
        // Passage order lets a fill walk the table once with a cursor; without
        // one, the oldest files go first, as since v0.9.
        after
          ? sql`order by c.attachment_id, c.ordinal`
          : sql`order by a.created_at, c.attachment_id, c.ordinal`
      }
      limit ${Math.max(1, Math.floor(options.limit))}
    `);
    return rows.map((row) => ({
      attachmentId: row.attachment_id,
      userId: row.user_id,
      organizationId: row.organization_id,
      ordinal: Number(row.ordinal),
      content: row.content,
    }));
  }

  async upsert(generation: Generation, passages: PassageVector[]): Promise<void> {
    if (passages.length === 0) return;
    const schemaName = await this.readySchema(generation);
    if (!schemaName) {
      throw new Error(`The storage of embedding generation ${generation.id} is not ready`);
    }
    for (const passage of passages) {
      if (
        passage.vector.length !== generation.dimensions ||
        !passage.vector.every(Number.isFinite)
      ) {
        throw new RangeError(
          `A vector for generation ${generation.id} must have ${generation.dimensions} finite numbers`,
        );
      }
    }
    const type = vectorType(schemaName);
    await db.execute(sql`
      insert into ${vectorTable(generation.tableName)} (attachment_id, ordinal, model_key, embedding)
      values ${sql.join(
        passages.map(
          (passage) =>
            sql`(${passage.attachmentId}, ${passage.ordinal}, ${generation.modelKey}, ${vectorLiteral(passage.vector)}::${type})`,
        ),
        sql`, `,
      )}
      on conflict (attachment_id, ordinal) do update
        set model_key = excluded.model_key, embedding = excluded.embedding, embedded_at = now()
    `);
  }

  /** Tables of every generation not dropped, and generation 1's before it is recorded. */
  private async storedTables(executor: TransactionExecutor): Promise<string[]> {
    const rows = await executor.execute<{ table_name: string }>(sql`
      select t.table_name
      from (
        select table_name from embedding_generation where state <> 'dropped'
        union
        select ${LEGACY_EMBEDDING_TABLE}
        where not exists (select 1 from embedding_generation where id = 1)
      ) t
      where to_regclass(t.table_name) is not null
      order by t.table_name
    `);
    return rows.map((row) => row.table_name);
  }

  private async deleteEverywhere(
    tx: TransactionExecutor | undefined,
    where: (table: ReturnType<typeof vectorTable>) => ReturnType<typeof sql>,
  ): Promise<number> {
    const run = async (executor: TransactionExecutor) => {
      let deleted = 0;
      for (const name of await this.storedTables(executor)) {
        const result = await executor.execute(where(vectorTable(name)));
        deleted += Number((result as { count?: number }).count ?? 0);
      }
      return deleted;
    };
    return tx ? run(tx) : db.transaction(run);
  }

  async deleteByPassage(passages: PassageRef[], tx?: TransactionExecutor): Promise<number> {
    if (passages.length === 0) return 0;
    const ids = textArray(passages.map((passage) => passage.attachmentId));
    const ordinals = sql`array[${sql.join(
      passages.map((passage) => sql`${passage.ordinal}`),
      sql`, `,
    )}]::int[]`;
    return this.deleteEverywhere(
      tx,
      (table) => sql`
        delete from ${table} e
        using unnest(${ids}, ${ordinals}) as p(attachment_id, ordinal)
        where e.attachment_id = p.attachment_id and e.ordinal = p.ordinal
      `,
    );
  }

  async deleteByFile(attachmentIds: string[], tx?: TransactionExecutor): Promise<number> {
    if (attachmentIds.length === 0) return 0;
    return this.deleteEverywhere(
      tx,
      (table) => sql`delete from ${table} where attachment_id = any(${textArray(attachmentIds)})`,
    );
  }

  async deleteByProject(projectId: string, tx?: TransactionExecutor): Promise<number> {
    return this.deleteEverywhere(
      tx,
      (table) => sql`
        delete from ${table} e using attachment a
        where a.id = e.attachment_id and a.project_id = ${projectId}
      `,
    );
  }

  async deleteByPerson(personId: string, tx?: TransactionExecutor): Promise<number> {
    return this.deleteEverywhere(
      tx,
      (table) => sql`
        delete from ${table} e using attachment a
        where a.id = e.attachment_id and a.user_id = ${personId}
      `,
    );
  }

  async hasVectors(generation: Generation, scope: VectorScope): Promise<boolean> {
    const filter = scopeFilter(scope);
    if (scope.fileIds?.length === 0) return false;
    if ((await this.readySchema(generation)) === null) return false;
    const [row] = await db.execute<{ found: boolean }>(sql`
      select exists (
        select 1 from ${vectorTable(generation.tableName)} e
        join attachment a on a.id = e.attachment_id
        where ${filter} and e.model_key = ${generation.modelKey}
      ) as found
    `);
    return row?.found === true;
  }

  async search(
    generation: Generation,
    scope: VectorScope,
    vector: number[],
    limit: number,
  ): Promise<VectorHit[]> {
    const filter = scopeFilter(scope);
    if (scope.fileIds?.length === 0 || limit <= 0) return [];
    if (vector.length !== generation.dimensions || !vector.every(Number.isFinite)) {
      throw new RangeError(`The query vector must have ${generation.dimensions} finite numbers`);
    }
    const schemaName = await this.readySchema(generation);
    if (!schemaName) return [];
    const rows = await db.execute<{ attachment_id: string; ordinal: number; distance: number }>(sql`
      select e.attachment_id, e.ordinal,
             (e.embedding ${cosineDistance(schemaName)} ${vectorLiteral(vector)}::${vectorType(schemaName)})::float8
               as distance
      from ${vectorTable(generation.tableName)} e
      join attachment a on a.id = e.attachment_id
      where ${filter} and e.model_key = ${generation.modelKey}
      order by distance, e.attachment_id, e.ordinal
      limit ${Math.floor(limit)}
    `);
    return rows.map((row) => ({
      attachmentId: row.attachment_id,
      ordinal: Number(row.ordinal),
      distance: Number(row.distance),
    }));
  }

  async recordFailure(generation: Generation, attachmentId: string, error: unknown) {
    const lastError = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_ERROR_CHARS,
    );
    await db.transaction(async (tx) => {
      const [previous] = await tx
        .select({ failures: F.failures })
        .from(F)
        .where(and(eq(F.generationId, generation.id), eq(F.attachmentId, attachmentId)))
        .for('update');
      const failures = (previous?.failures ?? 0) + 1;
      const changes = {
        failures,
        lastError,
        retryAt: new Date(Date.now() + failureBackoffMs(failures)),
        updatedAt: new Date(),
      };
      await tx
        .insert(F)
        .values({ generationId: generation.id, attachmentId, ...changes })
        .onConflictDoUpdate({ target: [F.generationId, F.attachmentId], set: changes });
    });
  }

  async clearFailure(generation: Generation, attachmentId: string) {
    await db
      .delete(schema.embeddingGenerationFailure)
      .where(and(eq(F.generationId, generation.id), eq(F.attachmentId, attachmentId)));
  }

  async failureSummary(generation: Generation): Promise<FailureSummary> {
    const [row] = await db.execute<{ files: number; last_error: string | null }>(sql`
      select count(*)::int as files,
             (select last_error from embedding_generation_failure
               where generation_id = ${generation.id}
               order by updated_at desc limit 1) as last_error
      from embedding_generation_failure
      where generation_id = ${generation.id}
    `);
    const files = Number(row?.files ?? 0);
    return { files, lastError: files > 0 ? (row?.last_error ?? null) : null };
  }
}
