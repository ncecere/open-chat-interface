import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  chunkTranscript,
  compactionDue,
  groupTurns,
  isContextOverflowError,
  SOFT_COMPACTION_RATIO,
  selectCutPoint,
  serializeConversation,
  serializeMessage,
  softThresholdUnits,
  summaryPrompt,
  TOOL_TEXT_LIMIT,
  truncateText,
  withSummary,
} from '../../services/chat/compaction-plan.js';

type Row = { id: string; role: 'user' | 'assistant'; parts: unknown[]; units?: number };
const text = (value: string) => ({ type: 'text', text: value });
const user = (id: string, units = 10): Row => ({ id, role: 'user', parts: [text(id)], units });
const reply = (id: string, units = 10, parts: unknown[] = [text(id)]): Row => ({
  id,
  role: 'assistant',
  parts,
  units,
});
const toolStep = (id: string, output: unknown) => ({
  type: 'tool-web_search',
  toolCallId: id,
  state: 'output-available',
  input: { query: 'library hours' },
  output,
});
const groups = (rows: Row[]) => groupTurns(rows, (row) => row.units ?? 0);
const cutAt = (rows: Row[], keep: number) => {
  const turns = groups(rows);
  const cut = selectCutPoint(turns, keep);
  return cut === null ? null : turns[cut]!.messages[0]!.id;
};

describe('compaction cut point', () => {
  it('cuts only at the start of a user turn, keeping recent turns within the share', () => {
    const rows = [
      user('u1'),
      reply('a1'),
      user('u2'),
      reply('a2'),
      user('u3'),
      reply('a3'),
      user('u4'),
      reply('a4'),
    ];
    // Each turn is 20 units: 45 keeps the newest two whole turns, never a half.
    expect(cutAt(rows, 45)).toBe('u3');
    expect(cutAt(rows, 60)).toBe('u2');
    // Everything fits: nothing would be summarised.
    expect(cutAt(rows, 1_000)).toBeNull();
  });

  it('never separates a tool step from its turn', () => {
    // The reply with tool steps is large; the cut cannot land inside it or
    // between the question and the reply that used tools.
    const rows = [
      user('u1'),
      reply('a1'),
      user('u2'),
      reply('a2-tools', 500, [toolStep('call-1', { hits: 3 }), text('found it')]),
      reply('a2-more', 10),
      user('u3'),
      reply('a3'),
    ];
    const cut = cutAt(rows, 100);
    expect(cut).toBe('u3');
    const turns = groups(rows);
    // The tool-using turn is one group: question, both replies.
    expect(turns[1]!.messages.map((row) => row.id)).toEqual(['u2', 'a2-tools', 'a2-more']);
    for (const turn of turns) expect(turn.messages[0]!.role).toBe('user');
  });

  it('keeps the newest turn whole even when it alone exceeds the share (split-turn case)', () => {
    const rows = [user('u1'), reply('a1'), user('u2', 5_000), reply('a2', 5_000)];
    // The newest turn is 10,000 units against a 100 unit share: everything
    // before it is summarised and it is kept whole, never split.
    expect(cutAt(rows, 100)).toBe('u2');
    expect(cutAt(rows, 0)).toBe('u2');
  });

  it('has nothing to summarise with a single turn or only leading replies', () => {
    expect(cutAt([user('u1'), reply('a1')], 0)).toBeNull();
    expect(cutAt([], 0)).toBeNull();
    // An imported conversation can start with a reply: a leading group that
    // may be summarised but is never a cut point.
    const rows = [reply('a0'), user('u1'), reply('a1')];
    const turns = groups(rows);
    expect(turns.map((turn) => turn.startsWithUser)).toEqual([false, true]);
    expect(cutAt(rows, 0)).toBe('u1');
    expect(cutAt([reply('a0'), reply('a1')], 0)).toBeNull();
  });

  it('starts a repeated compaction at the previous cut and must move past it', () => {
    // The span of a repeated compaction begins at the previous first kept
    // message (u3); the earlier turns are represented by the old summary.
    const sincePreviousCut = [user('u3'), reply('a3'), user('u4'), reply('a4')];
    expect(cutAt(sincePreviousCut, 25)).toBe('u4');
    // When the recent turns still fit, the cut would not move: no compaction.
    expect(cutAt(sincePreviousCut, 1_000)).toBeNull();
    // Index 0 (the previous cut) is never returned as the new cut.
    expect(selectCutPoint(groups(sincePreviousCut), 1_000)).toBeNull();
  });
});

describe('background compaction threshold', () => {
  it('is three quarters of the input budget', () => {
    expect(SOFT_COMPACTION_RATIO).toBe(0.75);
    expect(softThresholdUnits(14_488)).toBe(10_866);
    expect(softThresholdUnits(128_000)).toBe(96_000);
    expect(softThresholdUnits(3)).toBe(2);
  });

  it('is due only above the threshold', () => {
    expect(compactionDue({ historyUnits: 7_500, budgetUnits: 10_000 })).toBe(false);
    expect(compactionDue({ historyUnits: 7_501, budgetUnits: 10_000 })).toBe(true);
    expect(compactionDue({ historyUnits: 0, budgetUnits: 10_000 })).toBe(false);
    expect(compactionDue({ historyUnits: 50_000, budgetUnits: 10_000 })).toBe(true);
  });

  it('is due whenever a turn already had to leave turns out', () => {
    expect(compactionDue({ historyUnits: 10, budgetUnits: 10_000, limited: true })).toBe(true);
    expect(compactionDue({ historyUnits: 10, budgetUnits: 10_000, limited: false })).toBe(false);
  });
});

describe('compaction transcript', () => {
  it('labels each speaker and leaves reasoning and display parts out', () => {
    const transcript = serializeConversation([
      {
        role: 'user',
        parts: [
          text('What are the opening hours?'),
          {
            type: 'data-attachment',
            data: { id: 'f1', filename: 'hours.pdf', mimeType: 'application/pdf' },
          },
        ],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'SECRET_REASONING' },
          { type: 'step-start' },
          toolStep('call-1', { hours: '9-17' }),
          { type: 'source-url', sourceId: 's', url: 'https://example.test' },
          text('It opens at 9.'),
        ],
      },
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'only reasoning' }] },
    ]);
    expect(transcript).toBe(
      [
        '[User]: What are the opening hours?\n[User attached]: hours.pdf',
        '[Tool step]: web_search({"query":"library hours"}) -> {"hours":"9-17"}\n[Assistant]: It opens at 9.',
      ].join('\n\n'),
    );
    expect(transcript).not.toContain('SECRET_REASONING');
  });

  it('cuts tool results to 2,000 characters and reports failed or unfinished steps', () => {
    const long = 'x'.repeat(TOOL_TEXT_LIMIT + 500);
    const line = serializeMessage({
      role: 'assistant',
      parts: [
        toolStep('call-1', long),
        {
          type: 'tool-fetch',
          toolCallId: 'call-2',
          state: 'output-error',
          input: { url: 'https://example.test' },
          errorText: 'timed out',
        },
        // An approval nobody answered never reached the model; it is left out.
        {
          type: 'tool-send_note',
          toolCallId: 'call-3',
          state: 'approval-requested',
          input: { to: 'x' },
        },
      ],
    });
    const [first, second, third] = line.split('\n');
    expect(first).toContain(`${'x'.repeat(TOOL_TEXT_LIMIT)} [… 500 more characters left out]`);
    expect(first!.length).toBeLessThan(TOOL_TEXT_LIMIT + 200);
    expect(second).toBe('[Tool step]: fetch({"url":"https://example.test"}) -> Failed: timed out');
    expect(third).toBeUndefined();
    expect(truncateText('short', 10)).toBe('short');
  });

  it('serialises odd tool values without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const line = serializeMessage({
      role: 'assistant',
      parts: [
        { ...toolStep('call-1', 'plain text result'), input: circular },
        { type: 'tool-x', toolCallId: 'c2', state: 'output-available', input: 'raw' },
      ],
    });
    expect(line).toContain('web_search([object Object]) -> plain text result');
    expect(line).toContain('x(raw) -> null');
    expect(serializeMessage({ role: 'user', parts: 'not parts' })).toBe('');
  });

  it('packs turns into chunks newest first, leaving the oldest out beyond the limit', () => {
    const turns = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
    expect(chunkTranscript(turns, 100)).toEqual({
      chunks: [`${'a'.repeat(40)}\n\n${'b'.repeat(40)}`, `${'c'.repeat(40)}\n\n${'d'.repeat(40)}`],
      omittedTurns: 0,
    });
    const limited = chunkTranscript(turns, 50, 2);
    expect(limited.chunks).toEqual(['c'.repeat(40), 'd'.repeat(40)]);
    expect(limited.omittedTurns).toBe(2);
    // A single turn larger than a chunk is cut to fit, keeping its beginning.
    const [only] = chunkTranscript(['é'.repeat(200)], 120).chunks;
    expect(Buffer.byteLength(only!)).toBeLessThanOrEqual(120);
    expect(only).toMatch(/^é+ \[… the rest of this turn was left out\]$/);
    expect(chunkTranscript([], 100)).toEqual({ chunks: [], omittedTurns: 0 });
  });
});

describe('compaction prompt', () => {
  it('asks for the structured sections, carries the previous summary forward, and adds instructions', () => {
    const first = summaryPrompt({ transcript: '[User]: hi' });
    for (const heading of [
      '## Topic and goal',
      '## Facts, figures and decisions',
      "## The person's preferences and constraints",
      '## Open questions and next steps',
      '## Critical details',
    ])
      expect(first).toContain(heading);
    expect(first).not.toContain('<previous-summary>');
    const repeated = summaryPrompt({
      transcript: '[User]: more',
      previousSummary: 'OLD SUMMARY',
      instructions: '  keep the budget figures ',
    });
    expect(repeated.indexOf('<previous-summary>\nOLD SUMMARY')).toBeLessThan(
      repeated.indexOf('<conversation>'),
    );
    expect(repeated).toContain('The person asked the summary to focus on: keep the budget figures');
  });

  it('adds the summary to the system prompt as a delimited section', () => {
    expect(withSummary('Be brief.', null)).toBe('Be brief.');
    expect(withSummary('Be brief.', 'S')).toMatch(
      /^Be brief\.\n\n<conversation-summary>\n.*\n\nS\n<\/conversation-summary>$/s,
    );
    expect(withSummary('', 'S')).toMatch(/^<conversation-summary>/);
  });
});

describe('context overflow errors', () => {
  const apiError = (message: string, statusCode: number | undefined = 400, responseBody?: string) =>
    new APICallError({
      message,
      url: 'https://provider.test',
      requestBodyValues: {},
      statusCode,
      responseBody,
      isRetryable: false,
    });

  it('recognises provider messages for an overlong input', () => {
    for (const message of [
      "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens.",
      'prompt is too long: 210000 tokens > 200000 maximum',
      'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
      'Input is too long for requested model.',
      'Please reduce the length of the messages or completion.',
      'Prompt too long',
      'Request exceeds the context window of this model',
    ])
      expect(isContextOverflowError(apiError(message)), message).toBe(true);
    expect(
      isContextOverflowError(
        apiError('Bad request', 400, '{"error":{"code":"context_length_exceeded"}}'),
      ),
    ).toBe(true);
    expect(isContextOverflowError(apiError('maximum context length', 413))).toBe(true);
    expect(isContextOverflowError(apiError('maximum context length', undefined))).toBe(true);
  });

  it('finds the provider error inside retries and causes', () => {
    const inner = apiError('prompt is too long');
    expect(
      isContextOverflowError(
        new RetryError({ message: 'failed', reason: 'maxRetriesExceeded', errors: [inner] }),
      ),
    ).toBe(true);
    expect(isContextOverflowError(new Error('wrapped', { cause: inner }))).toBe(true);
  });

  it('is conservative: rate limits, other errors and plain errors are not overflow', () => {
    expect(isContextOverflowError(apiError('Rate limit: too many tokens per minute', 429))).toBe(
      false,
    );
    expect(isContextOverflowError(apiError('maximum context length', 500))).toBe(false);
    expect(isContextOverflowError(apiError('Invalid API key', 401))).toBe(false);
    expect(isContextOverflowError(apiError('max_tokens is too large', 400))).toBe(false);
    expect(isContextOverflowError(new Error('maximum context length'))).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError('prompt is too long')).toBe(false);
  });
});
