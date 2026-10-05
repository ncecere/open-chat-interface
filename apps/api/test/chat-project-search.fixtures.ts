import { randomUUID } from 'node:crypto';
import { type createDatabase, schema } from '@oci/db';
import type { SendMessageInput } from '@oci/shared';
import { convertToModelMessages } from 'ai';
import {
  addCost,
  contextBudget,
  MESSAGE_OVERHEAD,
  messageCost,
  textCost,
} from '../src/services/chat/context-budget.js';
import type { AcquiredRun } from '../src/services/chat/run-lifecycle.js';
import type { setupTurn } from '../src/services/chat/setup-turn.js';
import type { LocalStorageDriver } from '../src/services/storage/local-driver.js';

/**
 * Shared by the chat-project-search*.live.test.ts suites: large project files
 * that only reach the model as searched passages, turn preparation (setupTurn)
 * against real PostgreSQL and local blob storage, and the assembled model
 * input. Each suite declares its own mocks and creates its own database.
 */

export type StartedTurn = Awaited<ReturnType<typeof setupTurn>>;

export async function modelText(started: StartedTurn) {
  const messages = await convertToModelMessages(started.turn.uiMessages);
  return messages
    .flatMap((message) =>
      message.role === 'user' && Array.isArray(message.content) ? message.content : [],
    )
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
}

export function assembledCost(started: StartedTurn) {
  const system = textCost(started.turn.system);
  return started.turn.uiMessages.reduce((sum, message) => addCost(sum, messageCost(message)), {
    ...system,
    units: system.units + MESSAGE_OVERHEAD,
  });
}

export const KESTREL =
  'The launch code for Operation Kestrel is PELICAN-42, kept in the blue folder.';

/** A long handbook where exactly one paragraph is about Operation Kestrel. */
export function handbook(): string {
  return Array.from({ length: 40 }, (_, index) =>
    index === 25
      ? KESTREL
      : `Handbook section ${index} covers the routine upkeep of the office kitchen and the rota for the week ahead.`,
  ).join('\n\n');
}

/** A long appendix sharing no words with the question. */
export function appendix(): string {
  return Array.from(
    { length: 40 },
    (_, index) =>
      `Appendix note ${index} lists zebra xylophone quokka marmalade inventory values alphabetically.`,
  ).join('\n\n');
}

/** Returns `smallModel` bound to a suite's hoisted mock state. */
export function smallModelFor(state: {
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
}) {
  /** Input budget of 6,000 units by default: room for two passages in the search share. */
  return function smallModel(units = 6000) {
    state.contextWindow = units + 1000 + 512;
    state.maxOutputTokens = 1000;
    return contextBudget({
      contextWindow: state.contextWindow,
      maxOutputTokens: state.maxOutputTokens,
    });
  };
}

/** What the helpers need from a suite; read when a helper runs, after `beforeAll`. */
export interface ProjectSearchSuite {
  readonly pool: ReturnType<typeof createDatabase>;
  readonly owner: string;
  readonly organizationId: string;
  readonly driver: LocalStorageDriver;
  readonly runs: Set<AcquiredRun>;
  /** The suite's own import of project-search/indexing.js, made after its mocks. */
  readonly indexProjectFile: (attachmentId: string) => Promise<unknown>;
}

export function projectSearchHelpers(suite: ProjectSearchSuite) {
  async function project(name: string, userId = suite.owner) {
    const [row] = await suite.pool.db
      .insert(schema.project)
      .values({ organizationId: suite.organizationId, userId, name })
      .returning();
    return row!;
  }
  async function projectFile(
    projectId: string,
    filename: string,
    text: string | null,
    options: { userId?: string; index?: boolean; mimeType?: string } = {},
  ) {
    const body = text ?? 'binary';
    const [row] = await suite.pool.db
      .insert(schema.attachment)
      .values({
        organizationId: suite.organizationId,
        userId: options.userId ?? suite.owner,
        projectId,
        filename,
        mimeType: options.mimeType ?? 'text/plain',
        sizeBytes: Buffer.byteLength(body),
        storageKey: randomUUID(),
        extractedText: text,
      })
      .returning();
    await suite.driver.put(row!.storageKey, Buffer.from(body), options.mimeType ?? 'text/plain');
    if (options.index !== false) await suite.indexProjectFile(row!.id);
    return row!;
  }
  async function thread(projectId: string | null) {
    const [row] = await suite.pool.db
      .insert(schema.thread)
      .values({ userId: suite.owner, organizationId: suite.organizationId, projectId })
      .returning();
    return row!;
  }
  async function send(threadId: string, text: string, extra: Partial<SendMessageInput> = {}) {
    const { setupTurn } = await import('../src/services/chat/setup-turn.js');
    const started = await setupTurn(
      { id: suite.owner, name: 'Test User', role: 'user' },
      {
        threadId,
        modelSlug: 'test-model',
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        attachmentIds: [],
        trigger: 'submit-message',
        webSearch: false,
        temporary: false,
        ...extra,
      },
    );
    suite.runs.add(started.run);
    return started;
  }
  async function largeProject(name = 'Operations') {
    const operations = await project(name);
    const handbookFile = await projectFile(operations.id, 'handbook.txt', handbook());
    const appendixFile = await projectFile(operations.id, 'appendix.txt', appendix());
    return { operations, handbookFile, appendixFile };
  }

  return { project, projectFile, thread, send, largeProject };
}
