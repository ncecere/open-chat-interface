import { describe, expect, it } from 'vitest';
import {
  addCost,
  assertFitsContext,
  type ContextCost,
  contextBudget,
  emptyCost,
  fitsContext,
  historyGroups,
  IMAGE_INPUT_UNITS,
  MAX_CONTEXT_FILES,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_MESSAGES,
  MAX_IMAGE_BYTES,
  MAX_INPUT_UNITS,
  MESSAGE_OVERHEAD,
  messageCost,
  PART_OVERHEAD,
  selectContextSuffix,
  textCost,
} from '../../services/chat/context-budget.js';

const axes = ['units', 'files', 'imageBytes'] as const;
const cost = (units: number, files = 0, imageBytes = 0): ContextCost => ({
  units,
  files,
  imageBytes,
});
const group = (id: string, units: number) => ({
  items: [`${id}-user`, `${id}-assistant`],
  cost: cost(units),
});

describe('unit: context budget', () => {
  it('defines bounded history, input, attachment and framing ceilings', () => {
    expect({
      MAX_HISTORY_MESSAGES,
      MAX_HISTORY_BYTES,
      MAX_INPUT_UNITS,
      MAX_CONTEXT_FILES,
      MAX_IMAGE_BYTES,
      IMAGE_INPUT_UNITS,
      MESSAGE_OVERHEAD,
      PART_OVERHEAD,
    }).toEqual({
      MAX_HISTORY_MESSAGES: 128,
      MAX_HISTORY_BYTES: 524_288,
      MAX_INPUT_UNITS: 128_000,
      MAX_CONTEXT_FILES: 32,
      MAX_IMAGE_BYTES: 20_971_520,
      IMAGE_INPUT_UNITS: 8192,
      MESSAGE_OVERHEAD: 64,
      PART_OVERHEAD: 16,
    });
  });

  it('uses a conservative fallback window and output reserve for unknown models', () => {
    const expected = { units: 28_160, files: 32, imageBytes: 20_971_520, outputTokens: 4096 };
    expect(contextBudget({})).toEqual(expected);
    expect(contextBudget({ contextWindow: null, maxOutputTokens: null })).toEqual(expected);
  });

  it('scales default output down for small windows and rounds down fractional quarters', () => {
    expect(contextBudget({ contextWindow: 4099 })).toEqual({
      units: 2563,
      files: 32,
      imageBytes: 20_971_520,
      outputTokens: 1024,
    });
  });

  it('reserves explicit output caps and caps input independently of a large window', () => {
    expect(contextBudget({ contextWindow: 8192, maxOutputTokens: 2048 })).toEqual({
      units: 5632,
      files: 32,
      imageBytes: 20_971_520,
      outputTokens: 2048,
    });
    expect(contextBudget({ contextWindow: 1_000_000, maxOutputTokens: 16_384 })).toEqual({
      units: MAX_INPUT_UNITS,
      files: 32,
      imageBytes: 20_971_520,
      outputTokens: 16_384,
    });
  });

  it('rejects nonpositive, fractional, nonfinite and unsafe model limits', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => contextBudget({ contextWindow: value })).toThrow(
        'invalid context or output limit',
      );
      expect(() => contextBudget({ maxOutputTokens: value })).toThrow(
        'invalid context or output limit',
      );
    }
  });

  it('rejects windows with no input room instead of silently reducing output', () => {
    for (const contextWindow of [1535, 1536]) {
      expect(() => contextBudget({ contextWindow, maxOutputTokens: 1024 })).toThrow(
        'output limit leaves no room for input',
      );
    }
    expect(contextBudget({ contextWindow: 1537, maxOutputTokens: 1024 }).units).toBe(1);
  });

  it('accounts for actual assembled text and all base64 padding lengths without decoding image buffers', () => {
    for (const size of [1, 2, 3]) {
      const url = `data:image/png;base64,${Buffer.alloc(size).toString('base64')}`;
      expect(
        messageCost({
          id: 'test',
          role: 'user',
          parts: [
            { type: 'text', text: 'é' },
            { type: 'file', mediaType: 'image/png', filename: 'a.png', url },
          ],
        }),
      ).toEqual(cost(MESSAGE_OVERHEAD + PART_OVERHEAD + 2 + IMAGE_INPUT_UNITS + 5 + 128, 1, size));
    }
  });

  it('rejects arbitrary URLs and unsupported model parts rather than assigning them zero cost', () => {
    expect(() =>
      messageCost({
        id: 'test',
        role: 'user',
        parts: [{ type: 'file', mediaType: 'image/png', url: 'https://invalid.example/file' }],
      }),
    ).toThrow('Unsupported model input part');
    expect(() =>
      messageCost({
        id: 'test',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'unbudgeted' }],
      }),
    ).toThrow('Unsupported model input part');
  });

  it('charges UTF-8 bytes plus part overhead, not character count divided by four', () => {
    expect(textCost('')).toEqual(cost(16));
    expect(textCost('abcdefgh')).toEqual(cost(24));
    // Eight UTF-8 bytes, despite only three UTF-16 code units.
    expect(textCost('é漢€')).toEqual(cost(24));
    expect(textCost('\u{1F600}')).toEqual(cost(20));
  });

  it('creates fresh zero costs and adds all dimensions without mutating operands', () => {
    const zero = emptyCost();
    expect(zero).toEqual(cost(0));
    expect(emptyCost()).not.toBe(zero);
    const a = Object.freeze(cost(100, 2, 300));
    const b = Object.freeze(cost(20, 3, 400));
    const sum = addCost(a, b);
    expect(sum).toEqual(cost(120, 5, 700));
    expect(sum).not.toBe(a);
    expect(sum).not.toBe(b);
    expect(a).toEqual(cost(100, 2, 300));
    expect(b).toEqual(cost(20, 3, 400));
  });

  it('enforces units, file count and image bytes independently at their exact ceilings', () => {
    const budget = contextBudget({ contextWindow: 1_000_000 });
    expect(fitsContext(cost(MAX_INPUT_UNITS, MAX_CONTEXT_FILES, MAX_IMAGE_BYTES), budget)).toBe(
      true,
    );
    for (const axis of axes) {
      const boundary = { ...emptyCost(), [axis]: budget[axis] };
      expect(fitsContext(boundary, budget)).toBe(true);
      expect(() => assertFitsContext(boundary, budget)).not.toThrow();
      const overflow = { ...boundary, [axis]: budget[axis] + 1 };
      expect(fitsContext(overflow, budget)).toBe(false);
      expect(() => assertFitsContext(overflow, budget)).toThrow('exceed this model’s input budget');
      expect(
        selectContextSuffix([{ items: ['whole-turn'], cost: overflow }], emptyCost(), budget),
      ).toEqual({ items: [], cost: emptyCost(), limited: true });
    }
  });

  it('rejects invalid costs on every axis even when the numeric budget is generous', () => {
    const budget = cost(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    for (const axis of axes) {
      for (const value of [-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const invalid = { ...emptyCost(), [axis]: value };
        expect(fitsContext(invalid, budget)).toBe(false);
        expect(() => assertFitsContext(invalid, budget)).toThrow(
          'exceed this model’s input budget',
        );
      }
    }
    expect(fitsContext(emptyCost(), emptyCost())).toBe(true);
  });

  it('drops orphan leading assistants and groups complete turns in source order', () => {
    const messages = [
      { role: 'assistant', id: 'orphan-1' },
      { role: 'assistant', id: 'orphan-2' },
      { role: 'user', id: 'u1' },
      { role: 'assistant', id: 'a1' },
      { role: 'assistant', id: 'a2' },
      { role: 'user', id: 'u2' },
      { role: 'user', id: 'u3' },
      { role: 'assistant', id: 'a3' },
    ];
    expect(historyGroups(messages)).toEqual([
      messages.slice(2, 5),
      [messages[5]],
      messages.slice(6),
    ]);
    expect(historyGroups(messages.slice(0, 2))).toEqual([]);
    expect(historyGroups([])).toEqual([]);
  });

  it('selects a chronological suffix of whole turns and reports all accumulated costs', () => {
    const groups = [group('old', 70), group('middle', 30), group('recent', 40)];
    groups[1]!.cost = cost(30, 1, 10);
    groups[2]!.cost = cost(40, 2, 20);
    expect(selectContextSuffix(groups, cost(20, 1, 5), cost(100, 4, 35))).toEqual({
      items: ['middle-user', 'middle-assistant', 'recent-user', 'recent-assistant'],
      cost: cost(90, 4, 35),
      limited: true,
    });
  });

  it('stops at the first oversized recent turn rather than cherry-picking older cheap turns', () => {
    const groups = [group('cheap-old', 5), group('too-large', 100), group('recent', 20)];
    expect(selectContextSuffix(groups, cost(10), cost(40))).toEqual({
      items: ['recent-user', 'recent-assistant'],
      cost: cost(30),
      limited: true,
    });
    expect(selectContextSuffix(groups.slice(0, 2), cost(10), cost(40))).toEqual({
      items: [],
      cost: cost(10),
      limited: true,
    });
  });

  it('never silently drops required latest-message or system-instruction costs', () => {
    const budget = cost(100, 2, 50);
    const latest = cost(60, 1, 30);
    const system = cost(41);
    expect(() => selectContextSuffix([], addCost(latest, system), budget)).toThrow(
      'latest message, instructions or attachments exceed',
    );
    for (const axis of axes) {
      const required = { ...emptyCost(), [axis]: budget[axis] + 1 };
      expect(() => selectContextSuffix([group('old', 1)], required, budget)).toThrow(
        'exceed this model’s input budget',
      );
    }
    expect(selectContextSuffix([group('old', 1)], budget, budget)).toEqual({
      items: [],
      cost: budget,
      limited: true,
    });
  });

  it('accepts exact-boundary whole-history fits and empty history without marking them limited', () => {
    const groups = [{ items: ['user', 'assistant'], cost: cost(80, 1, 30) }];
    expect(selectContextSuffix(groups, cost(20, 1, 20), cost(100, 2, 50))).toEqual({
      items: ['user', 'assistant'],
      cost: cost(100, 2, 50),
      limited: false,
    });
    expect(selectContextSuffix([], cost(20, 1, 20), cost(20, 1, 20))).toEqual({
      items: [],
      cost: cost(20, 1, 20),
      limited: false,
    });
  });

  it('preserves original messages, groups, required costs and budget during selection', () => {
    const messages = [
      { role: 'user', id: 'u1' },
      { role: 'assistant', id: 'a1' },
      { role: 'user', id: 'u2' },
      { role: 'assistant', id: 'a2' },
    ];
    const messageSnapshot = structuredClone(messages);
    const groups = historyGroups(messages).map((items) => ({ items, cost: cost(30) }));
    const required = cost(10);
    const budget = cost(50);
    const snapshot = structuredClone({ groups, required, budget });
    const result = selectContextSuffix(groups, required, budget);
    expect(result).toEqual({ items: messages.slice(2), cost: cost(40), limited: true });
    expect(result.items).not.toBe(groups[1]!.items);
    expect(result.items[0]).toBe(messages[2]);
    expect(result.items[1]).toBe(messages[3]);
    expect(result.cost).not.toBe(required);
    expect(messages).toEqual(messageSnapshot);
    expect({ groups, required, budget }).toEqual(snapshot);
  });
});
