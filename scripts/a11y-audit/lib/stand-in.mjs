/**
 * A stand-in for the model, so the walkthroughs can send, stop, approve a tool and open an
 * artifact on an instance with no working model provider (as the e2e suite's CI has none).
 *
 * The conversation, tool and artifact fixtures are the shapes the e2e specs already route
 * (tools.spec.ts, artifact-panel-resize.spec.ts, chat-scroll.spec.ts). Streaming has to be in
 * the page: `route.fulfill` delivers a whole body at once, and Stop needs a reply still running.
 */

const CREATED = '2026-01-01T00:00:00.000Z';

export const TOOLS_THREAD = 'a11y-audit-tools';
export const ARTIFACT_THREAD = 'a11y-audit-artifact';

/** Runs in the page: answers POST /api/chat with a stream that runs until aborted or done. */
const slowStream = ({ chunkMs, chunks }) => {
  const original = window.fetch.bind(window);
  const stored = {};
  const json = (body) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.href,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const history = url.pathname.match(/^\/api\/chat\/([^/]+)\/messages$/);
    if (history && method === 'GET' && stored[history[1]]) {
      return json({
        thread: { id: history[1], temporary: false, expiresAt: null },
        messages: stored[history[1]],
        replies: [],
      });
    }
    if (url.pathname === '/api/chat' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const prompt = body.messages?.[0];
      const id = `a11y-reply-${Date.now()}`;
      const encoder = new TextEncoder();
      const event = (data) =>
        encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      const words = Array.from({ length: chunks }, (_, index) => `word${index} `);
      let aborted = false;
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      window.__a11yStream = { started: Date.now(), aborted: false, finished: false };
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(event({ type: 'start', messageId: id }));
          controller.enqueue(event({ type: 'text-start', id: 'text' }));
          for (const word of words) {
            await new Promise((resolve) => setTimeout(resolve, chunkMs));
            if (aborted) {
              window.__a11yStream.aborted = true;
              try {
                controller.close();
              } catch {
                // Already closed by the abort.
              }
              return;
            }
            controller.enqueue(event({ type: 'text-delta', id: 'text', delta: word }));
          }
          controller.enqueue(event({ type: 'text-end', id: 'text' }));
          controller.enqueue(event({ type: 'finish' }));
          controller.enqueue(event('[DONE]'));
          window.__a11yStream.finished = true;
          stored[body.threadId] = [
            { ...prompt, metadata: { status: 'complete', createdAt: new Date().toISOString() } },
            {
              id,
              role: 'assistant',
              parts: [{ type: 'text', text: words.join('') }],
              metadata: { status: 'complete', createdAt: new Date().toISOString() },
            },
          ];
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      });
    }
    return original(input, init);
  };
};

/** Replaces the model with one that streams `chunks` words, one every `chunkMs`. */
export async function installSlowReply(page, { chunkMs = 350, chunks = 40 } = {}) {
  await page.addInitScript(slowStream, { chunkMs, chunks });
}

const user = (id, text) => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
  metadata: { status: 'complete', createdAt: CREATED },
});

/** A conversation whose last reply waits for approval of a tool; approving continues it. */
export async function installToolApproval(page) {
  const noteRequest = {
    type: 'tool-send_note',
    toolCallId: 'note-1',
    title: 'Send note',
    state: 'approval-requested',
    input: { to: 'Ada', text: 'The library opens at 9.' },
    approval: { id: 'approval-1' },
  };
  let answered = false;
  const reply = () => ({
    id: 'reply-2',
    role: 'assistant',
    parts: answered
      ? [
          { type: 'step-start' },
          { type: 'text', text: 'I can send that note.' },
          {
            ...noteRequest,
            state: 'output-available',
            output: { sent: true },
            approval: { id: 'approval-1', approved: true },
          },
          { type: 'step-start' },
          { type: 'text', text: 'Sent the note to Ada.' },
        ]
      : [{ type: 'step-start' }, { type: 'text', text: 'I can send that note.' }, noteRequest],
    metadata: { status: 'complete', createdAt: CREATED },
  });
  await page.route(`**/api/chat/${TOOLS_THREAD}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: TOOLS_THREAD, temporary: false, expiresAt: null },
        messages: [user('prompt-1', 'Send Ada a note about the opening hours'), reply()],
        replies: [],
      }),
    }),
  );
  await page.route(`**/api/chat/${TOOLS_THREAD}/approvals`, async (route) => {
    answered = true;
    const events = [
      { type: 'start', messageId: 'reply-2', messageMetadata: {} },
      { type: 'tool-output-available', toolCallId: 'note-1', output: { sent: true } },
      { type: 'start-step' },
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'Sent the note to Ada.' },
      { type: 'text-end', id: 'text' },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'stop' },
    ];
    await route.fulfill({
      headers: {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
        'X-OCI-Chat-Run-Id': 'reply-2:continue',
        'X-OCI-Prompt-Message-Id': 'prompt-2',
      },
      body: `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    });
  });
}

/** A conversation with a finished reply that wrote a document, so the artifact panel can open. */
export async function installArtifact(page) {
  const doc = '# Plan\n\nA short plan.';
  const artifact = {
    id: 'a11y-audit-artifact',
    threadId: ARTIFACT_THREAD,
    messageId: 'answer',
    sourceKey: 'tool:c1',
    title: 'Plan',
    kind: 'markdown',
    currentVersion: 1,
    sizeBytes: doc.length,
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
  await page.route(`**/api/chat/${ARTIFACT_THREAD}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: ARTIFACT_THREAD, temporary: false, expiresAt: null },
        messages: [
          user('question', 'Write a plan'),
          {
            id: 'answer',
            role: 'assistant',
            parts: [
              {
                type: 'tool-create_artifact',
                toolCallId: 'c1',
                state: 'output-available',
                input: { title: 'Plan', kind: 'markdown', content: doc },
                output: {
                  artifactId: artifact.id,
                  title: 'Plan',
                  kind: 'markdown',
                  version: 1,
                  sizeBytes: doc.length,
                },
              },
              { type: 'text', text: 'Here is the plan.' },
            ],
            metadata: { status: 'complete', createdAt: '2026-01-01T00:00:01.000Z' },
          },
        ],
        replies: [],
      }),
    }),
  );
  await page.route(`**/api/artifacts?threadId=${ARTIFACT_THREAD}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts: [artifact] }),
    }),
  );
  await page.route(`**/api/artifacts/${artifact.id}`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifact,
        versions: [
          {
            version: 1,
            sizeBytes: doc.length,
            source: 'reply',
            messageId: 'answer',
            createdAt: artifact.createdAt,
          },
        ],
        content: doc,
      }),
    }),
  );
}
