import { inflateSync } from 'node:zlib';

/**
 * Reads what a pdfkit PDF draws, without a renderer: which fonts are
 * embedded, and for each embedded (Type0, Identity-H) font the glyph codes
 * drawn with it and their text (through the font's ToUnicode map), in
 * drawing order. Enough to prove that no character was drawn as `.notdef`
 * (subset glyph 0, which pdfkit always keeps at code 0000) and in which
 * order and forms right-to-left text was drawn.
 */

interface PdfObject {
  dict: string;
  stream?: Buffer;
}

function objects(bytes: Uint8Array): Map<number, PdfObject> {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString('latin1');
  const found = new Map<number, PdfObject>();
  const header = /(\d+) 0 obj\s*/g;
  for (let match = header.exec(text); match; match = header.exec(text)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endobj', start);
    const body = text.slice(start, end);
    header.lastIndex = end;
    const streamAt = body.indexOf('stream');
    if (streamAt < 0) {
      found.set(Number(match[1]), { dict: body });
      continue;
    }
    const dict = body.slice(0, streamAt);
    header.lastIndex = start + streamAt + Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
    const length = Number(/\/Length (\d+)/.exec(dict)?.[1] ?? 0);
    let from = start + streamAt + 'stream'.length;
    if (text[from] === '\r') from++;
    if (text[from] === '\n') from++;
    const raw = buffer.subarray(from, from + length);
    found.set(Number(match[1]), {
      dict,
      stream: dict.includes('/FlateDecode') ? inflateSync(raw) : raw,
    });
  }
  return found;
}

const ref = (value: string | undefined) => (value ? Number(value) : undefined);

/** ToUnicode: code → text. */
function toUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  const decode = (hex: string) =>
    String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((unit) => Number.parseInt(unit, 16)));
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const [, code, value] of block[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi))
      map.set(Number.parseInt(code!, 16), decode(value!));
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const [, from, to, list, single] of block[1]!.matchAll(
      /<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(?:\[([^\]]*)\]|<([0-9a-f]*)>)/gi,
    )) {
      const first = Number.parseInt(from!, 16);
      const last = Number.parseInt(to!, 16);
      const values = list ? [...list.matchAll(/<([0-9a-f]*)>/gi)].map((item) => item[1]!) : null;
      for (let code = first; code <= last; code++) {
        if (values) map.set(code, decode(values[code - first] ?? ''));
        else {
          const base = decode(single!);
          map.set(
            code,
            base.slice(0, -1) +
              String.fromCharCode(base.charCodeAt(base.length - 1) + code - first),
          );
        }
      }
    }
  return map;
}

export interface DrawnText {
  /** The font's base name without its subset tag, e.g. `NotoSansArabic-Regular`. */
  font: string;
  codes: number[];
  text: string;
}

export interface PdfInspection {
  /** Names of embedded fonts (subset tags removed). */
  embedded: string[];
  /** Standard (not embedded) fonts used. */
  standard: string[];
  /** Text drawn with embedded fonts, one entry per string, in drawing order. */
  drawn: DrawnText[];
}

export function inspectPdf(bytes: Uint8Array): PdfInspection {
  const all = objects(bytes);
  const fonts = new Map<
    number,
    { name: string; embedded: boolean; unicode: Map<number, string> }
  >();
  for (const [id, object] of all) {
    if (!/\/Type \/Font/.test(object.dict)) continue;
    const name = /\/BaseFont \/([^\s/>]+)/.exec(object.dict)?.[1]?.replace(/^[A-Z]{6}\+/, '');
    if (!name) continue;
    if (/\/Subtype \/Type0/.test(object.dict)) {
      const cmap = ref(/\/ToUnicode (\d+) 0 R/.exec(object.dict)?.[1]);
      const stream = cmap !== undefined ? all.get(cmap)?.stream?.toString('latin1') : undefined;
      fonts.set(id, { name, embedded: true, unicode: toUnicode(stream ?? '') });
    } else if (/\/Subtype \/Type1/.test(object.dict))
      fonts.set(id, { name, embedded: false, unicode: new Map() });
  }
  // Resource names (/F1 …) to font objects, from every page's resources.
  const named = new Map<string, number>();
  for (const object of all.values())
    for (const block of object.dict.matchAll(/\/Font\s*<<([^>]*)>>/g))
      for (const [, name, id] of block[1]!.matchAll(/\/(\w+) (\d+) 0 R/g))
        named.set(name!, Number(id));
  const drawn: DrawnText[] = [];
  const standard = new Set<string>();
  for (const object of all.values()) {
    if (!object.stream || /\/Type \/(XObject|Metadata)|\/Subtype|\/Length1/.test(object.dict))
      continue;
    const content = object.stream.toString('latin1');
    if (!/\bTf\b/.test(content)) continue;
    let current: ReturnType<typeof fonts.get>;
    for (const token of content.matchAll(/\/(\w+) [\d.]+ Tf|\[([^\]]*)\] TJ|<([0-9a-f]*)> Tj/gi)) {
      if (token[1]) {
        current = fonts.get(named.get(token[1]) ?? -1);
        if (current && !current.embedded) standard.add(current.name);
        continue;
      }
      if (!current?.embedded) continue;
      const hex = token[2]
        ? [...token[2].matchAll(/<([0-9a-f]*)>/gi)].map((item) => item[1]!).join('')
        : token[3]!;
      const codes = (hex.match(/.{4}/g) ?? []).map((unit) => Number.parseInt(unit, 16));
      drawn.push({
        font: current.name,
        codes,
        text: codes.map((code) => current!.unicode.get(code) ?? '').join(''),
      });
    }
  }
  return {
    embedded: [
      ...new Set([...fonts.values()].filter((font) => font.embedded).map((font) => font.name)),
    ],
    standard: [...standard],
    drawn,
  };
}
