/**
 * Keeps a reply's single line breaks (#207).
 *
 * In CommonMark a single newline inside a paragraph is a "soft" break that
 * renders as a space, so a haiku, an address or a list written without
 * Markdown markers ran together on one line. Chat interfaces (ChatGPT,
 * Claude) keep them, and so do people reading a reply: models write a
 * newline where they mean one. This remark plugin turns each newline left in
 * a text node into a hard break, as remark-breaks does, without a new
 * dependency. Code, inline code and math are not text nodes, so they are
 * untouched; a hard break the author wrote (two trailing spaces or a
 * backslash) is already a break node and stays a single break.
 *
 * Product decision: chat Markdown keeps single line breaks.
 */

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

function splitText(node: MdastNode): MdastNode[] {
  const lines = (node.value ?? '').split('\n');
  return lines.flatMap((line, index) => {
    // A newline ends the line; trailing spaces before it are not content.
    const text = index < lines.length - 1 ? line.replace(/[ \t]+$/, '') : line;
    const parts: MdastNode[] = index > 0 ? [{ type: 'break' }] : [];
    if (text) parts.push({ type: 'text', value: text });
    return parts;
  });
}

function keepBreaks(node: MdastNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value?.includes('\n')) return splitText(child);
    keepBreaks(child);
    return [child];
  });
}

export function remarkSoftBreaks() {
  return (tree: MdastNode) => keepBreaks(tree);
}
