import { strFromU8, unzipSync } from 'fflate';

/**
 * A small well-formedness check for generated Office XML: every tag closes in
 * order, attribute values hold no raw `<`, and every `&` starts an entity.
 * Enough to catch unescaped content without an XML parser dependency.
 */
export function assertWellFormedXml(xml: string, name = 'document'): void {
  const body = xml
    .replace(/^<\?xml[^>]*\?>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const badEntity = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(body);
  if (badEntity) throw new Error(`${name}: bare "&" at ${badEntity.index}`);
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  let last = 0;
  for (let match = tag.exec(body); match; match = tag.exec(body)) {
    const between = body.slice(last, match.index);
    if (between.includes('<') || between.includes('>'))
      throw new Error(`${name}: stray markup near ${match.index}: ${between.slice(0, 80)}`);
    last = tag.lastIndex;
    const [, closing, element, , selfClosing] = match;
    if (selfClosing) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== element) throw new Error(`${name}: </${element}> closes <${open}>`);
    } else stack.push(element!);
  }
  const rest = body.slice(last);
  if (rest.includes('<') || rest.includes('>')) throw new Error(`${name}: stray markup at end`);
  if (stack.length > 0) throw new Error(`${name}: unclosed <${stack.at(-1)}>`);
}

/** The text files of a zip (Office) package, by path. */
export function unzipText(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => /\.(xml|rels)$/.test(path))
      .map(([path, content]) => [path, strFromU8(content)]),
  );
}

/** Every `<a:t>`/`<w:t>` text in order, entities decoded. */
export function xmlTexts(xml: string, element: 'w:t' | 'a:t' | 't'): string[] {
  const pattern = new RegExp(`<${element}(?:\\s[^>]*)?>([^<]*)</${element}>`, 'g');
  return [...xml.matchAll(pattern)].map((match) =>
    match[1]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/&amp;/g, '&'),
  );
}
