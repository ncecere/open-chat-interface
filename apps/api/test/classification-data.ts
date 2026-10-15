import { randomUUID } from 'node:crypto';
import type { createDatabase } from '@oci/db';
import { sql } from '@oci/db';

/**
 * Raw-SQL builders for the data classification suites: rows written the way
 * a v0.13 replica (or a migration) would write them, with no application code
 * between the test and the schema.
 */
export function classificationData(
  pool: ReturnType<typeof createDatabase>,
  organizationId: string,
  owner: string,
) {
  const run = async (query: ReturnType<typeof sql>) => (await pool.db.execute(query)) as unknown[];
  let counter = 0;
  const id = () => `${randomUUID().slice(0, 8)}-${++counter}`;

  return {
    run,
    id,
    async dataClass(name: string, options: { retired?: boolean } = {}) {
      const classId = id();
      await run(sql`insert into data_class (id, organization_id, name, retired_at)
        values (${classId}, ${organizationId}, ${name}, ${options.retired ? new Date().toISOString() : null}::timestamptz)`);
      return classId;
    },
    async model(slug: string, approvedFor: string[] = [], displayName = slug) {
      const providerId = id();
      const modelId = id();
      await run(sql`insert into provider (id, organization_id, kind, label)
        values (${providerId}, ${organizationId}, 'openai-compatible', ${`P ${slug}`})`);
      await run(sql`insert into model (id, organization_id, provider_id, slug, upstream_model_id, display_name, capabilities)
        values (${modelId}, ${organizationId}, ${providerId}, ${slug}, 'u', ${displayName}, '["tool_calling"]'::jsonb)`);
      for (const classId of approvedFor)
        await run(
          sql`insert into model_data_class (model_id, data_class_id) values (${modelId}, ${classId})`,
        );
      return modelId;
    },
    async project(classIds: string[] = [], options: { locked?: boolean } = {}) {
      const projectId = id();
      await run(
        sql`insert into project (id, organization_id, user_id, name) values (${projectId}, ${organizationId}, ${owner}, 'P')`,
      );
      for (const classId of classIds)
        await run(sql`insert into project_data_class (project_id, data_class_id, locked)
          values (${projectId}, ${classId}, ${options.locked ?? false})`);
      return projectId;
    },
    async thread(options: { projectId?: string; parentId?: string } = {}) {
      const threadId = id();
      await run(sql`insert into thread (id, organization_id, user_id, title, project_id, parent_thread_id)
        values (${threadId}, ${organizationId}, ${owner}, 'T', ${options.projectId ?? null}, ${options.parentId ?? null})`);
      return threadId;
    },
    async connector(name: string, classIds: string[] = [], slug = `c${++counter}`) {
      const connectorId = id();
      await run(sql`insert into connector (id, organization_id, name, slug, url)
        values (${connectorId}, ${organizationId}, ${name}, ${slug}, 'https://mcp.example.test')`);
      for (const classId of classIds)
        await run(sql`insert into connector_data_class (connector_id, data_class_id)
          values (${connectorId}, ${classId})`);
      return connectorId;
    },
    async use(threadId: string, connectorId: string) {
      await run(
        sql`insert into thread_connector_use (thread_id, connector_id) values (${threadId}, ${connectorId})`,
      );
    },
    async label(threadId: string, classId: string, source: 'person' | 'kept' = 'person') {
      await run(sql`insert into thread_data_class (thread_id, data_class_id, source, origin, created_by)
        values (${threadId}, ${classId}, ${source}, ${source === 'kept' ? 'project' : ''}, ${source === 'person' ? owner : null})`);
    },
    async clear() {
      await run(sql`delete from thread`);
      await run(sql`delete from project`);
      await run(sql`delete from connector`);
      await run(sql`delete from data_class`);
      await run(sql`delete from model`);
      await run(sql`delete from provider`);
      await run(sql`delete from background_migration where name = '0.14.thread-connector-use'`);
    },
  };
}

/**
 * Records every statement the pool runs outside a transaction, so a test can
 * say which tables a path touched (the `off` mode must read none of the
 * classification tables). Call the returned function to stop recording.
 */
export function recordStatements(pool: ReturnType<typeof createDatabase>) {
  const statements: string[] = [];
  const original = pool.sql.unsafe.bind(pool.sql);
  const patched = ((query: string, ...rest: unknown[]) => {
    statements.push(query);
    return (original as (...args: unknown[]) => unknown)(query, ...rest);
  }) as typeof pool.sql.unsafe;
  pool.sql.unsafe = patched;
  return {
    statements,
    stop() {
      pool.sql.unsafe = original as typeof pool.sql.unsafe;
    },
  };
}

/** What a statement text says about classification: any of its tables. */
export const TOUCHES_CLASSIFICATION =
  /data_class|thread_connector_use|project_data_class|thread_data_class|model_data_class|connector_data_class/;
