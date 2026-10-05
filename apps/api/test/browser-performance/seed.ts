import { randomUUID } from 'node:crypto';
import { type Database, eq, schema } from '@oci/db';
import { FIXTURE_MODEL } from './provider.js';

export const ADMIN_EMAIL = 'browser-fixture@example.test';

export interface FixtureScenario {
  label: string;
  kind: 'history' | 'empty';
  threadId: string;
  messageCount: number;
  path: string;
}

function historyMarkdown(thread: number, pair: number): string {
  return `## Local history ${thread}, turn ${pair}

This **deterministic** history is synthetic. No real user conversations are loaded. Its paragraphs, tables, and code blocks exercise normal markdown rendering in a long conversation.

| Stage | State | Samples |
| --- | --- | ---: |
| Load | Complete | 50 |
| Render | Ready | 100 |
| Stream | Local only | 100 |

### Review checklist

1. Open the thread and inspect the previous messages.
2. Scroll through the markdown without changing the dataset.
3. Submit a new message to receive a fixed local streaming response.

\`\`\`typescript
const history = { thread: ${thread}, turn: ${pair}, complete: true };
const results = ['load', 'render', 'stream'].map((stage) => ({
  stage,
  ...history,
}));
\`\`\`

> These fixtures measure the application, not model intelligence or token accuracy.
`;
}

/** Messages in the long-conversation scenario (v0.11, item 21). */
export const LONG_CONVERSATION_MESSAGES = 2_000;
/** In the first user message and the last reply, so a runner can tell both ends apart. */
export const LONG_START_MARKER = 'LONG-FIXTURE-START';
export const LONG_END_MARKER = 'LONG-FIXTURE-END';
/** Every DIAGRAM_EVERY-th reply has a Mermaid diagram, every HTML_EVERY-th an HTML artifact. */
const DIAGRAM_EVERY = 100;
const HTML_EVERY = 250;

const longDiagram = (turn: number) => `flowchart LR
  A[Question ${turn}] --> B[Search]
  B --> C[Draft]
  C --> D[Answer ${turn}]`;

const longHtml = (turn: number) => `<!doctype html>
<html>
<head><title>Report ${turn}</title></head>
<body>
<h1>Report ${turn}</h1>
<p>Synthetic artifact for the long conversation fixture.</p>
<ul>
<li>One</li>
<li>Two</li>
</ul>
</body>
</html>`;

/**
 * One reply of the long conversation: prose, a table, a highlighted code
 * block, and now and then a diagram or an HTML artifact (both saved as
 * artifacts below), roughly the mix of a long working session.
 */
export function longReply(turn: number, last: boolean): string {
  const extra =
    turn % HTML_EVERY === 0
      ? `\n\n\`\`\`html\n${longHtml(turn)}\n\`\`\`\n`
      : turn % DIAGRAM_EVERY === 0
        ? `\n\n\`\`\`mermaid\n${longDiagram(turn)}\n\`\`\`\n`
        : '';
  return `### Long conversation reply ${turn}

This is reply **${turn}** of a long, synthetic working session. It mixes prose, a small table and code, as long chats do.

| Step | Value |
| --- | ---: |
| Turn | ${turn} |
| Lines | ${turn * 3} |

\`\`\`typescript
export function step${turn}(input: number[]): number {
  // Turn ${turn}: sum the even values, then scale them.
  return input.filter((value) => value % 2 === 0).reduce((sum, value) => sum + value * ${turn}, 0);
}
\`\`\`${extra}${last ? `\n\n${LONG_END_MARKER}` : ''}
`;
}

export async function seedBrowserData(db: Database, encryptedApiKey: string) {
  const [admin] = await db.select().from(schema.user).where(eq(schema.user.email, ADMIN_EMAIL));
  if (!admin?.organizationId) throw new Error('Fixture administrator is missing');
  const organizationId = admin.organizationId;
  const scenarios: FixtureScenario[] = [];

  await db.transaction(async (tx) => {
    const providerId = randomUUID();
    await tx.insert(schema.provider).values({
      id: providerId,
      organizationId,
      kind: 'openai-compatible',
      label: 'Browser fixture (local synthetic provider)',
      baseUrl: 'http://127.0.0.1:4181/v1',
      encryptedApiKey,
      enabled: true,
    });
    await tx.insert(schema.model).values({
      id: randomUUID(),
      organizationId,
      providerId,
      slug: FIXTURE_MODEL,
      upstreamModelId: FIXTURE_MODEL,
      displayName: 'Browser fixture',
      description: 'Local deterministic markdown; synthetic token usage.',
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      supportedEfforts: [],
      capabilities: [],
      visibleToRoles: ['admin', 'user'],
      isDefault: true,
      enabled: true,
    });

    const labels = [
      ...Array.from({ length: 12 }, (_, i) => `history-${String(i + 1).padStart(2, '0')}`),
      'cold-load-baseline',
      'cold-load-candidate',
      'small-chat-baseline',
      'small-chat-candidate',
      'long-conversation',
    ];
    for (const [index, label] of labels.entries()) {
      const threadId = randomUUID();
      const long = label === 'long-conversation';
      const messageCount = long ? LONG_CONVERSATION_MESSAGES : index < 12 ? 100 : 0;
      const createdAt = new Date(Date.UTC(2025, 0, index + 1));
      const updatedAt = new Date(createdAt.getTime() + Math.max(0, messageCount - 1) * 1_000);
      await tx.insert(schema.thread).values({
        id: threadId,
        organizationId,
        userId: admin.id,
        title: `Fixture: ${label}`,
        createdAt,
        updatedAt,
        lastMessageAt: messageCount ? updatedAt : null,
      });
      const messages: (typeof schema.message.$inferInsert)[] = [];
      const artifacts: Array<{ messageId: string; kind: 'mermaid' | 'html'; turn: number }> = [];
      for (let pair = 0; pair < messageCount / 2; pair++) {
        const promptId = randomUUID();
        const turn = pair + 1;
        for (const role of ['user', 'assistant'] as const) {
          const position = pair * 2 + (role === 'assistant' ? 1 : 0);
          const timestamp = new Date(createdAt.getTime() + position * 1_000);
          const id = role === 'user' ? promptId : randomUUID();
          const text = long
            ? role === 'user'
              ? `${turn === 1 ? `${LONG_START_MARKER} ` : ''}Long conversation question ${turn}: continue the review.`
              : longReply(turn, turn === messageCount / 2)
            : role === 'user'
              ? `Summarize local fixture ${index + 1}, turn ${pair + 1}, using a table and code.`
              : historyMarkdown(index + 1, pair + 1);
          if (long && role === 'assistant' && turn % DIAGRAM_EVERY === 0)
            artifacts.push({
              messageId: id,
              kind: turn % HTML_EVERY === 0 ? 'html' : 'mermaid',
              turn,
            });
          messages.push({
            id,
            threadId,
            userId: admin.id,
            role,
            position,
            // Match production lineage: assistant -> its user prompt; user -> null.
            parentMessageId: role === 'assistant' ? promptId : null,
            parts: [{ type: 'text', text }],
            modelSlug: FIXTURE_MODEL,
            status: 'complete',
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
      }
      for (let start = 0; start < messages.length; start += 500)
        await tx.insert(schema.message).values(messages.slice(start, start + 500));
      // Saved as the reply's code-block artifacts would be: the second fence
      // (after the TypeScript one) is `block:1`.
      for (const artifact of artifacts) {
        const content =
          artifact.kind === 'html' ? longHtml(artifact.turn) : longDiagram(artifact.turn);
        const [row] = await tx
          .insert(schema.artifact)
          .values({
            userId: admin.id,
            threadId,
            messageId: artifact.messageId,
            sourceKey: 'block:1',
            title: artifact.kind === 'html' ? `Report ${artifact.turn}` : 'Flowchart',
            kind: artifact.kind,
          })
          .returning({ id: schema.artifact.id });
        if (!row) throw new Error('Fixture artifact was not stored');
        await tx.insert(schema.artifactVersion).values({
          artifactId: row.id,
          version: 1,
          content,
          sizeBytes: Buffer.byteLength(content),
          source: 'reply',
          messageId: artifact.messageId,
        });
      }
      scenarios.push({
        label,
        kind: messageCount ? 'history' : 'empty',
        threadId,
        messageCount,
        path: `/chat/${threadId}`,
      });
    }
  });
  return scenarios;
}
