import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters } from '../../src/components/chat/markdown';

/**
 * Models emit LaTeX bracket delimiters that the math plugin does not accept.
 * Rewriting them is only safe if code spans are left alone.
 */
describe('math delimiter normalization', () => {
  it('rewrites inline bracket delimiters to dollars', () => {
    expect(normalizeMathDelimiters(String.raw`scales as \(I \propto \lambda^{-4}\) here`)).toBe(
      String.raw`scales as $I \propto \lambda^{-4}$ here`,
    );
  });

  it('rewrites display bracket delimiters to double dollars', () => {
    expect(normalizeMathDelimiters(String.raw`\[E = mc^2\]`)).toBe('$$E = mc^2$$');
  });

  it('leaves existing dollar math untouched', () => {
    const input = 'inline $a^2$ and display $$b^2$$';
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('does not rewrite inside a fenced code block', () => {
    const input = ['```python', String.raw`print("\(not math\)")`, '```'].join('\n');
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('does not rewrite inside an inline code span', () => {
    const input = String.raw`use \`\(literal\)\` verbatim`;
    expect(normalizeMathDelimiters(input)).toBe(input);
  });

  it('handles multiple expressions in one paragraph', () => {
    expect(normalizeMathDelimiters(String.raw`\(a\) and \(b\)`)).toBe('$a$ and $b$');
  });

  it('spans newlines inside a display expression', () => {
    expect(normalizeMathDelimiters('\\[\na + b\n\\]')).toBe('$$\na + b\n$$');
  });

  it('leaves ordinary prose unchanged', () => {
    const input = 'A sentence with (parentheses) and [brackets].';
    expect(normalizeMathDelimiters(input)).toBe(input);
  });
});
