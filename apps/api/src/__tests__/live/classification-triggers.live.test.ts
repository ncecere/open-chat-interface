import { createDatabase, sql } from '@oci/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLiveDatabase,
  type LiveDatabase,
  livePostgresAvailable,
  seedOrganization,
  seedUser,
} from '../../../test/live-postgres.js';

/**
 * Migration 0052's triggers (#395). Every write here is raw SQL, exactly as a
 * v0.13 replica running against the new schema during a rolling upgrade would
 * write it (its code knows nothing of classes): moving a conversation, deleting
 * a project or a connector, and forking must still leave the labels in place.
 */
const available = await livePostgresAvailable();

describe.skipIf(!available)('live data classification: triggers (a v0.13 replica writes)', () => {
  let live: LiveDatabase;
  let pool: ReturnType<typeof createDatabase>;
  let organizationId: string;
  let owner: string;
  let counter = 0;

  const id = () => `id-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  const run = async (query: ReturnType<typeof sql>) => (await pool.db.execute(query)) as unknown[];

  async function dataClass(name: string) {
    const classId = id();
    await run(
      sql`insert into data_class (id, organization_id, name) values (${classId}, ${organizationId}, ${name})`,
    );
    return classId;
  }
  async function project(classIds: string[] = []) {
    const projectId = id();
    await run(
      sql`insert into project (id, organization_id, user_id, name) values (${projectId}, ${organizationId}, ${owner}, 'P')`,
    );
    for (const classId of classIds)
      await run(
        sql`insert into project_data_class (project_id, data_class_id) values (${projectId}, ${classId})`,
      );
    return projectId;
  }
  async function thread(options: { projectId?: string; parentId?: string } = {}) {
    const threadId = id();
    await run(sql`insert into thread (id, organization_id, user_id, title, project_id, parent_thread_id)
      values (${threadId}, ${organizationId}, ${owner}, 'T', ${options.projectId ?? null}, ${options.parentId ?? null})`);
    return threadId;
  }
  async function connector(name: string, classIds: string[] = []) {
    const connectorId = id();
    await run(sql`insert into connector (id, organization_id, name, slug, url)
      values (${connectorId}, ${organizationId}, ${name}, ${`c${counter}`}, 'https://mcp.example.test')`);
    for (const classId of classIds)
      await run(
        sql`insert into connector_data_class (connector_id, data_class_id) values (${connectorId}, ${classId})`,
      );
    return connectorId;
  }
  async function use(threadId: string, connectorId: string) {
    await run(
      sql`insert into thread_connector_use (thread_id, connector_id) values (${threadId}, ${connectorId})`,
    );
  }
  async function labels(threadId: string) {
    return (await run(sql`select data_class_id, source, origin from thread_data_class
      where thread_id = ${threadId} order by data_class_id, source`)) as Array<{
      data_class_id: string;
      source: string;
      origin: string;
    }>;
  }

  beforeAll(async () => {
    live = await createLiveDatabase('classification_triggers');
    pool = createDatabase(live.connectionString, { max: 4 });
    organizationId = await seedOrganization(pool.db);
    owner = await seedUser(pool.db, organizationId);
  });
  beforeEach(async () => {
    await run(sql`delete from thread`);
    await run(sql`delete from project`);
    await run(sql`delete from connector`);
    await run(sql`delete from data_class`);
  });
  afterAll(async () => {
    await pool?.sql.end({ timeout: 1 });
    await live?.destroy();
  });

  describe('moving a conversation out of a project', () => {
    it('freezes the project classes as kept labels, whatever the destination', async () => {
      const student = await dataClass('Student');
      const health = await dataClass('Health');
      const from = await project([student, health]);
      const other = await project([]);
      const toNone = await thread({ projectId: from });
      const toOther = await thread({ projectId: from });
      await run(sql`update thread set project_id = null where id = ${toNone}`);
      await run(sql`update thread set project_id = ${other} where id = ${toOther}`);
      for (const threadId of [toNone, toOther])
        expect(await labels(threadId)).toEqual(
          [student, health]
            .sort()
            .map((classId) => ({ data_class_id: classId, source: 'kept', origin: 'project' })),
        );
      // The project keeps its own labels: only the conversation's copy was frozen.
      expect(
        await run(sql`select 1 from project_data_class where project_id = ${from}`),
      ).toHaveLength(2);
    });

    it('does nothing for a conversation that had no project, or whose project did not change', async () => {
      const student = await dataClass('Student');
      const home = await project([student]);
      const loose = await thread();
      await run(sql`update thread set project_id = ${home} where id = ${loose}`);
      expect(await labels(loose)).toEqual([]);
      await run(sql`update thread set project_id = ${home}, title = 'Renamed' where id = ${loose}`);
      expect(await labels(loose)).toEqual([]);
    });

    it('is idempotent when the conversation goes back and out again', async () => {
      const student = await dataClass('Student');
      const home = await project([student]);
      const chat = await thread({ projectId: home });
      await run(sql`update thread set project_id = null where id = ${chat}`);
      await run(sql`update thread set project_id = ${home} where id = ${chat}`);
      await run(sql`update thread set project_id = null where id = ${chat}`);
      expect(await labels(chat)).toHaveLength(1);
    });
  });

  describe('deleting a project', () => {
    it('freezes its classes onto every conversation in it, and onto no other', async () => {
      const student = await dataClass('Student');
      const home = await project([student]);
      const other = await project([]);
      const inside = await thread({ projectId: home });
      const alsoInside = await thread({ projectId: home });
      const outside = await thread({ projectId: other });
      await run(sql`delete from project where id = ${home}`);
      for (const threadId of [inside, alsoInside])
        expect(await labels(threadId)).toEqual([
          { data_class_id: student, source: 'kept', origin: 'project' },
        ]);
      expect(await labels(outside)).toEqual([]);
      const [row] = (await run(sql`select project_id from thread where id = ${inside}`)) as Array<{
        project_id: string | null;
      }>;
      expect(row?.project_id).toBeNull();
    });

    it('needs no help from the move trigger: its own BEFORE trigger is enough', async () => {
      // The cascade to project_data_class and the SET NULL on thread.project_id
      // are AFTER triggers in no guaranteed order, which is why this is a
      // BEFORE trigger. DDL is transactional: drop the other trigger, delete,
      // look, and roll back.
      const student = await dataClass('Student');
      const home = await project([student]);
      const chat = await thread({ projectId: home });
      const frozen = await pool.sql
        .begin(async (tx) => {
          await tx`drop trigger thread_keep_project_classes on thread`;
          await tx`delete from project where id = ${home}`;
          const rows =
            await tx`select data_class_id, source from thread_data_class where thread_id = ${chat}`;
          // Rolled back by throwing the answer out of the transaction.
          throw Object.assign(new Error('rollback'), { rows: [...rows] });
        })
        .catch((error: Error & { rows?: unknown[] }) => error.rows);
      expect(frozen).toEqual([{ data_class_id: student, source: 'kept' }]);
      expect(await run(sql`select 1 from project where id = ${home}`)).toHaveLength(1);
    });

    it('keeps the labels when the owner is deleted with their projects and conversations', async () => {
      const student = await dataClass('Student');
      const person = await seedUser(pool.db, organizationId);
      const projectId = id();
      await run(
        sql`insert into project (id, organization_id, user_id, name) values (${projectId}, ${organizationId}, ${person}, 'P')`,
      );
      await run(
        sql`insert into project_data_class (project_id, data_class_id, created_by) values (${projectId}, ${student}, ${person})`,
      );
      const chat = id();
      await run(sql`insert into thread (id, organization_id, user_id, title, project_id)
        values (${chat}, ${organizationId}, ${person}, 'T', ${projectId})`);
      await run(sql`delete from "user" where id = ${person}`);
      expect(await run(sql`select 1 from thread where id = ${chat}`)).toHaveLength(0);
      expect(
        await run(sql`select 1 from thread_data_class where thread_id = ${chat}`),
      ).toHaveLength(0);
      // The class itself is untouched and can now be deleted.
      await run(sql`delete from data_class where id = ${student}`);
    });
  });

  describe('deleting a connector', () => {
    it('freezes what it carried onto the conversations that used it, naming it', async () => {
      const student = await dataClass('Student');
      const sis = await connector('SIS', [student]);
      const users = await thread();
      const bystander = await thread();
      await use(users, sis);
      await run(sql`delete from connector where id = ${sis}`);
      expect(await labels(users)).toEqual([
        { data_class_id: student, source: 'kept', origin: 'connector: SIS' },
      ]);
      expect(await labels(bystander)).toEqual([]);
      expect(await run(sql`select 1 from thread_connector_use`)).toHaveLength(0);
    });

    it('freezes nothing for a connector that carried nothing', async () => {
      const plain = await connector('Wiki');
      const chat = await thread();
      await use(chat, plain);
      await run(sql`delete from connector where id = ${plain}`);
      expect(await labels(chat)).toEqual([]);
    });
  });

  describe('forking', () => {
    it('copies the parent labels and connector uses to a thread inserted with a parent', async () => {
      const student = await dataClass('Student');
      const health = await dataClass('Health');
      const sis = await connector('SIS', [student]);
      const parent = await thread();
      await run(sql`insert into thread_data_class (thread_id, data_class_id, source, created_by)
        values (${parent}, ${health}, 'person', ${owner})`);
      await run(sql`insert into thread_data_class (thread_id, data_class_id, source, origin)
        values (${parent}, ${student}, 'kept', 'project')`);
      await use(parent, sis);
      const fork = await thread({ parentId: parent });
      expect(await labels(fork)).toEqual(
        [
          { data_class_id: health, source: 'person', origin: '' },
          { data_class_id: student, source: 'kept', origin: 'project' },
        ].sort((a, b) => a.data_class_id.localeCompare(b.data_class_id)),
      );
      expect(
        await run(sql`select connector_id from thread_connector_use where thread_id = ${fork}`),
      ).toEqual([{ connector_id: sis }]);
    });

    it('copies nothing for an ordinary thread, or a parent that carries nothing', async () => {
      const parent = await thread();
      const fork = await thread({ parentId: parent });
      expect(await labels(fork)).toEqual([]);
      expect(await run(sql`select 1 from thread_connector_use`)).toHaveLength(0);
    });
  });

  describe('deleting a class', () => {
    it('is refused while a project, a conversation or a connector uses it', async () => {
      const student = await dataClass('Student');
      const home = await project([student]);
      await expect(run(sql`delete from data_class where id = ${student}`)).rejects.toThrow();
      await run(sql`delete from project_data_class where project_id = ${home}`);
      const chat = await thread();
      await run(
        sql`insert into thread_data_class (thread_id, data_class_id, source) values (${chat}, ${student}, 'person')`,
      );
      await expect(run(sql`delete from data_class where id = ${student}`)).rejects.toThrow();
      await run(sql`delete from thread_data_class where thread_id = ${chat}`);
      const sis = await connector('SIS', [student]);
      await expect(run(sql`delete from data_class where id = ${student}`)).rejects.toThrow();
      await run(sql`delete from connector where id = ${sis}`);
      await run(sql`delete from data_class where id = ${student}`);
    });

    it('takes its model approvals with it', async () => {
      const student = await dataClass('Student');
      const providerId = id();
      const modelId = id();
      await run(sql`insert into provider (id, organization_id, kind, label)
        values (${providerId}, ${organizationId}, 'openai-compatible', 'P')`);
      await run(sql`insert into model (id, organization_id, provider_id, slug, upstream_model_id, display_name)
        values (${modelId}, ${organizationId}, ${providerId}, ${`m${counter}`}, 'u', 'M')`);
      await run(
        sql`insert into model_data_class (model_id, data_class_id) values (${modelId}, ${student})`,
      );
      await run(sql`delete from data_class where id = ${student}`);
      expect(await run(sql`select 1 from model_data_class`)).toHaveLength(0);
    });

    it('treats names as unique per organization regardless of case', async () => {
      await dataClass('Student records');
      await expect(dataClass('STUDENT RECORDS')).rejects.toThrow();
    });
  });
});
