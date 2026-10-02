import {
  defaultToolAllowed,
  summarizeToolPart,
  toolLimitNote,
  toolStepsOf,
  updateRoleToolsSchema,
} from '@oci/shared';
import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  audits: [] as unknown[],
  chat: {} as Record<string, unknown>,
}));
vi.mock('../../services/audit.js', () => ({
  recordAudit: async (event: unknown) => {
    mocks.audits.push(event);
  },
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => (key === 'chat' ? mocks.chat : {}),
  updateSetting: async () => ({}),
}));
vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { AppError } = await import('../../lib/errors.js');
const { buildSdkTools, capToolResult, MAX_TOOL_RESULT_CHARS, ToolFailure, toolErrorText } =
  await import('../../services/tools/registry.js');
const { resolveRoleToolAllowed } = await import('../../services/tools/role-tools.js');
const { webSearchSources } = await import('../../services/tools/web-search.js');
const { maxToolSteps, stepsTaken, toolStreamErrorText } = await import(
  '../../services/chat/tool-loop.js'
);
const { settleOpenApprovals, openApprovals } = await import(
  '../../services/chat/pending-approvals.js'
);
const { historyParts } = await import('../../services/chat/message-parts.js');
const { exportableParts, renderMarkdown } = await import('../../services/export.js');
const { sanitizePublicParts } = await import('../../services/share-links.js');

beforeEach(() => {
  mocks.audits = [];
  mocks.chat = {};
});

const search = {
  type: 'tool-web_search',
  toolCallId: 's1',
  state: 'output-available',
  input: { query: 'opening hours' },
  output: { results: [{ url: 'https://a.test', title: 'A', snippet: 'RAW' }] },
  callProviderMetadata: { openai: { itemId: 'secret-item' } },
};

describe('tool registry', () => {
  it('caps a large result and reports its full size', () => {
    expect(capToolResult({ ok: true })).toEqual({ value: { ok: true }, bytes: 11 });
    expect(capToolResult(undefined)).toEqual({ value: null, bytes: 4 });
    const big = capToolResult({ text: 'x'.repeat(MAX_TOOL_RESULT_CHARS) });
    expect(big.value).toMatchObject({ truncated: true });
    expect((big.value as { text: string }).text).toHaveLength(MAX_TOOL_RESULT_CHARS);
    expect(big.bytes).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
  });

  it('shows only its own failure wording', () => {
    expect(toolErrorText(new ToolFailure('Search failed.'))).toBe('Search failed.');
    expect(toolErrorText(new Error('ECONNREFUSED 10.0.0.1'))).toBe('An error occurred.');
    expect(toolStreamErrorText(new ToolFailure('Mine'))).toBe('Mine');
    expect(toolStreamErrorText('raw')).toBe('This tool is not available in this conversation.');
    expect(toolStreamErrorText(new NoSuchToolError({ toolName: 'x', availableTools: [] }))).toBe(
      'This tool is not available in this conversation.',
    );
    expect(
      toolStreamErrorText(
        new InvalidToolInputError({ toolName: 'x', toolInput: '{}', cause: new Error('bad') }),
      ),
    ).toBe('The tool input was not valid.');
    expect(toolStreamErrorText(new Error('internal'))).toBe('An error occurred.');
  });

  it('runs a tool with a time limit, caps its result and audits metadata only', async () => {
    const definition = {
      id: 'lookup',
      label: 'Lookup',
      description: 'Looks up',
      kind: 'read' as const,
      source: 'builtin' as const,
      inputSchema: z.object({ q: z.string() }),
      available: () => true,
      execute: vi.fn(async (_input: unknown, options: { signal: AbortSignal }) => {
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return { answer: 'PRIVATE_RESULT' };
      }),
    };
    const caller = { userId: 'u', role: 'user' as const, threadId: 't', messageId: 'm' };
    const tools = buildSdkTools({ definitions: [definition] }, caller);
    const execute = tools.lookup!.execute!;
    await expect(
      execute({ q: 'PRIVATE_INPUT' }, { toolCallId: 'c1', messages: [], context: {} } as never),
    ).resolves.toEqual({ answer: 'PRIVATE_RESULT' });
    expect(mocks.audits).toHaveLength(1);
    expect(JSON.stringify(mocks.audits)).not.toContain('PRIVATE');
    expect(mocks.audits[0]).toMatchObject({
      action: 'tool.call',
      metadata: { toolId: 'lookup', outcome: 'ok', approval: null, approvalRequired: false },
    });

    definition.execute.mockRejectedValueOnce(
      new AppError('PROVIDER_ERROR', 'Search is down.', 502),
    );
    await expect(
      execute({ q: 'x' }, { toolCallId: 'c2', messages: [], context: {} } as never),
    ).rejects.toThrow('Search is down.');
    definition.execute.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      execute({ q: 'x' }, {
        toolCallId: 'c3',
        messages: [],
        context: {},
        abortSignal: new AbortController().signal,
      } as never),
    ).rejects.toThrow('Lookup failed. Try again later.');
    expect(mocks.audits.slice(1)).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'error' }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'error' }) }),
    ]);
  });

  it('defaults built-in read tools on except for restricted, and honours saved choices', () => {
    const read = { id: 'web_search', kind: 'read' as const, source: 'builtin' as const };
    const write = { id: 'send', kind: 'write' as const, source: 'builtin' as const };
    const connector = { id: 'mcp.crm.find', kind: 'read' as const, source: 'connector' as const };
    expect(resolveRoleToolAllowed('user', read, undefined)).toBe(true);
    expect(resolveRoleToolAllowed('restricted', read, undefined)).toBe(false);
    expect(resolveRoleToolAllowed('user', write, undefined)).toBe(false);
    expect(resolveRoleToolAllowed('admin', connector, {})).toBe(false);
    expect(
      resolveRoleToolAllowed('restricted', read, { roles: { restricted: { web_search: true } } }),
    ).toBe(true);
    expect(resolveRoleToolAllowed('user', read, { roles: { user: { web_search: false } } })).toBe(
      false,
    );
    expect(defaultToolAllowed('auditor', read)).toBe(true);
    expect(updateRoleToolsSchema.safeParse({ tools: {} }).success).toBe(false);
    expect(updateRoleToolsSchema.safeParse({ tools: { 'Bad Id': true } }).success).toBe(false);
    expect(updateRoleToolsSchema.safeParse({ tools: { 'mcp.crm.find': true } }).success).toBe(true);
  });

  it('turns web search results into sources, skipping anything that is not a web link', () => {
    expect(
      webSearchSources({
        results: [
          { url: 'https://a.test', title: 'A' },
          { url: 'javascript:alert(1)', title: 'B' },
          { url: 'http://c.test', title: '' },
          null,
        ],
      }),
    ).toEqual([
      { url: 'https://a.test', title: 'A' },
      { url: 'http://c.test', title: 'http://c.test' },
    ]);
    expect(webSearchSources(null)).toEqual([]);
  });
});

describe('reply loop helpers', () => {
  it('reads the step limit, clamped to 1–20 with a default of 8', async () => {
    await expect(maxToolSteps()).resolves.toBe(8);
    mocks.chat = { maxToolSteps: 50 };
    await expect(maxToolSteps()).resolves.toBe(20);
    mocks.chat = { maxToolSteps: 0 };
    await expect(maxToolSteps()).resolves.toBe(1);
    mocks.chat = { maxToolSteps: 2.5 };
    await expect(maxToolSteps()).resolves.toBe(8);
  });

  it('counts the steps a reply has already taken', () => {
    expect(stepsTaken([{ type: 'step-start' }, search, { type: 'step-start' }, null])).toBe(2);
  });

  it('describes a limit note for each reason', () => {
    expect(toolLimitNote('steps', 3)).toBe('This reply reached the limit of 3 steps and stopped.');
    expect(toolLimitNote('allowance')).toContain('allowance ran out');
    expect(toolLimitNote('context')).toContain('input limit');
  });
});

describe('open approvals', () => {
  const requested = {
    type: 'tool-send',
    toolCallId: 'w1',
    state: 'approval-requested',
    input: { to: 'Ada' },
    approval: { id: 'a1' },
  };
  it('denies the unanswered as "not answered" and fails approved steps that never ran', () => {
    const approvedNotRun = {
      ...requested,
      toolCallId: 'w2',
      state: 'approval-responded',
      approval: { id: 'a2', approved: true },
    };
    const deniedNotRun = {
      ...requested,
      toolCallId: 'w3',
      state: 'approval-responded',
      approval: { id: 'a3', approved: false },
    };
    expect(openApprovals([requested, approvedNotRun, search])).toEqual([requested]);
    const { parts, unanswered } = settleOpenApprovals([
      requested,
      approvedNotRun,
      deniedNotRun,
      search,
    ]);
    expect(unanswered).toEqual(['send']);
    expect(parts).toEqual([
      {
        ...requested,
        state: 'output-denied',
        approval: { id: 'a1', approved: false, reason: 'not answered' },
      },
      { ...approvedNotRun, state: 'output-error', errorText: 'This step did not run.' },
      { ...deniedNotRun, state: 'output-denied' },
      search,
    ]);
  });
});

describe('history and summaries', () => {
  const failed = {
    type: 'tool-web_search',
    toolCallId: 's2',
    state: 'output-error',
    input: { query: 'q' },
  };
  const denied = {
    type: 'tool-send',
    toolCallId: 'w1',
    state: 'output-denied',
    input: { to: 'Ada' },
    approval: { id: 'a1', approved: false, reason: 'not answered' },
  };
  const parts = [
    { type: 'text', text: 'Hi' },
    search,
    failed,
    denied,
    { type: 'tool-send', toolCallId: 'w9', state: 'input-available', input: {} },
    {
      type: 'dynamic-tool',
      toolName: 'x',
      toolCallId: 'd',
      state: 'output-error',
      input: {},
      errorText: 'no',
    },
    { type: 'reasoning', text: 'hidden' },
    null,
  ];

  it('keeps finished tool steps for the model without provider metadata', () => {
    expect(historyParts(parts, true)).toEqual([
      { type: 'text', text: 'Hi' },
      {
        type: 'tool-web_search',
        toolCallId: 's1',
        input: { query: 'opening hours' },
        state: 'output-available',
        output: search.output,
      },
      {
        type: 'tool-web_search',
        toolCallId: 's2',
        input: { query: 'q' },
        state: 'output-error',
        errorText: 'The tool failed.',
      },
      {
        type: 'tool-send',
        toolCallId: 'w1',
        input: { to: 'Ada' },
        state: 'output-error',
        errorText: 'The person did not approve this call (not answered).',
      },
    ]);
    expect(historyParts('nope', true)).toEqual([]);
  });

  it('turns tool steps into text when the turn offers no tools', () => {
    const text = historyParts(parts, false);
    expect(text).toHaveLength(4);
    expect(text.every((part) => part.type === 'text')).toBe(true);
    expect(JSON.stringify(text[1])).toContain('Tool step: web_search was called with');
  });

  it('summarises every step without its raw result', () => {
    expect(toolStepsOf(parts).map((step) => step.summary)).toEqual([
      "Searched the web for 'opening hours' · 1 result",
      "Web search for 'q' failed",
      'send was not run (not answered)',
      'Using send',
      'x failed',
    ]);
    expect(summarizeToolPart({ ...search, title: 'Search' }).label).toBe('Search');
    expect(
      summarizeToolPart({ type: 'tool-web_search', toolCallId: 'r', state: 'input-streaming' })
        .summary,
    ).toBe('Searching the web');
    expect(summarizeToolPart({ ...denied, type: 'tool-web_search' }).summary).toBe(
      'Web search was not run (not answered)',
    );
    expect(
      summarizeToolPart({ ...denied, state: 'approval-requested', approval: { id: 'a' } }),
    ).toMatchObject({
      state: 'awaiting-approval',
      approvalId: 'a',
      summary: 'send is waiting for your approval',
    });
    expect(
      summarizeToolPart({
        ...denied,
        state: 'approval-responded',
        approval: { id: 'a', approved: true },
      }).state,
    ).toBe('approved');
    expect(summarizeToolPart({ ...search, type: 'tool-send' }).summary).toBe('Used send');
    expect(summarizeToolPart({ ...search, output: {} }).summary).toBe(
      "Searched the web for 'opening hours' · 0 results",
    );
    expect(summarizeToolPart({ ...search, input: { query: 'x'.repeat(100) } }).summary).toContain(
      '…',
    );
    expect(toolStepsOf(null)).toEqual([]);
  });

  it('exports summaries and inputs, never raw results', () => {
    const stored = parts.filter(Boolean) as Record<string, unknown>[];
    const exported = exportableParts(stored);
    expect(JSON.stringify(exported)).not.toContain('RAW');
    expect(JSON.stringify(exported)).not.toContain('secret-item');
    expect(exported[3]).toEqual({
      type: 'tool-send',
      toolCallId: 'w1',
      state: 'output-denied',
      input: { to: 'Ada' },
      summary: 'send was not run (not answered)',
      approval: { approved: false, reason: 'not answered' },
    });
    expect(exported[5]).toMatchObject({ type: 'dynamic-tool', toolName: 'x' });
    const markdown = renderMarkdown({ title: 'T', createdAt: new Date() }, [
      {
        role: 'assistant',
        parts: [...stored, { type: 'data-tool-limit', data: { reason: 'steps', steps: 4 } }],
        modelSlug: null,
        status: 'complete',
        createdAt: new Date(),
      },
    ]);
    expect(markdown).toContain("_Searched the web for 'opening hours' · 1 result_");
    expect(markdown).toContain('_This reply reached the limit of 4 steps and stopped._');
    expect(markdown).not.toContain('RAW');
  });

  it('shares finished steps as summaries only', () => {
    const shared = sanitizePublicParts([
      search,
      { ...denied, state: 'approval-requested', approval: { id: 'a' } },
      { type: 'tool-send', toolCallId: 'w9', state: 'input-available', input: {} },
    ]);
    expect(shared).toEqual([
      {
        type: 'tool-step',
        toolId: 'web_search',
        summary: "Searched the web for 'opening hours' · 1 result",
      },
    ]);
  });
});
