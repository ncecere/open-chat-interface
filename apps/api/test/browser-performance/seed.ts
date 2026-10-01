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
    ];
    for (const [index, label] of labels.entries()) {
      const threadId = randomUUID();
      const messageCount = index < 12 ? 100 : 0;
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
      for (let pair = 0; pair < messageCount / 2; pair++) {
        const promptId = randomUUID();
        for (const role of ['user', 'assistant'] as const) {
          const position = pair * 2 + (role === 'assistant' ? 1 : 0);
          const timestamp = new Date(createdAt.getTime() + position * 1_000);
          messages.push({
            id: role === 'user' ? promptId : randomUUID(),
            threadId,
            userId: admin.id,
            role,
            position,
            // Match production lineage: assistant -> its user prompt; user -> null.
            parentMessageId: role === 'assistant' ? promptId : null,
            parts: [
              {
                type: 'text',
                text:
                  role === 'user'
                    ? `Summarize local fixture ${index + 1}, turn ${pair + 1}, using a table and code.`
                    : historyMarkdown(index + 1, pair + 1),
              },
            ],
            modelSlug: FIXTURE_MODEL,
            status: 'complete',
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
      }
      if (messages.length) await tx.insert(schema.message).values(messages);
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
