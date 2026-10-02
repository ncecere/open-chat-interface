import { describe, expect, it } from 'vitest';
import { clip, singleLine, stripControls, tsqueryOperand } from '../../lib/text.js';

describe('shared text helpers', () => {
  it('removes control characters, including the search highlight markers', () => {
    expect(stripControls('a\u0001b\u0002c\u007fd\te\nf')).toBe('a b c d\te\nf');
  });

  it('quotes tsquery operands so quotes and backslashes stay literal', () => {
    expect(tsqueryOperand("o'neil\\x", false)).toBe("'o''neil\\\\x'");
    expect(tsqueryOperand('plan', true)).toBe("'plan':*");
  });

  it('clips long text with an ellipsis and leaves short text alone', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 4)).toBe('abc');
  });

  it('puts a name on one line', () => {
    expect(singleLine('  Grant\n\tproposal  2026 ')).toBe('Grant proposal 2026');
  });
});
