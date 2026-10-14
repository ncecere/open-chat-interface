// A reader for the small YAML subset tools/scale/k8s uses, so the manifests can be checked (label,
// namespace, security fields) by node tests and by cluster.sh before anything is applied, with no
// dependency. Supported: block mappings and sequences, plain/quoted scalars, `|` and `|-` block
// scalars, [] and {} and one-line flow sequences of scalars, comments, and `---` documents.
// Anything else (anchors, tags, flow mappings, folded scalars, tabs) throws rather than guessing;
// kubeconform (tools/scale/k8s/validate.sh) is the check that the files are real Kubernetes YAML.

export class YamlError extends Error {}
const fail = (message, line) => {
  throw new YamlError(`YAML: ${message}${line === undefined ? '' : ` (line ${line + 1})`}`);
};

const significant = (line) => {
  const text = line.trim();
  return text !== '' && !text.startsWith('#');
};
const indentOf = (line) => line.length - line.trimStart().length;
const isSequenceItem = (text) => text === '-' || text.startsWith('- ');

function next(reader) {
  while (reader.pos < reader.lines.length && !significant(reader.lines[reader.pos])) reader.pos++;
  if (reader.pos >= reader.lines.length) return null;
  const raw = reader.lines[reader.pos];
  return { indent: indentOf(raw), text: raw.trim(), pos: reader.pos };
}

/** Drops a trailing ` # comment`, leaving quoted text alone. */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const atTokenStart = i === 0 || /[\s[,]/.test(text[i - 1]);
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      }
    } else if ((c === '"' || c === "'") && atTokenStart) quote = c;
    else if (c === '#' && atTokenStart) return text.slice(0, i);
  }
  return text;
}

function unquote(text, line) {
  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) fail(`unterminated string ${text}`, line);
    return text.slice(1, -1).replace(/\\(["\\/nt])/g, (_, ch) => ({ n: '\n', t: '\t' })[ch] ?? ch);
  }
  if (text.length < 2 || !text.endsWith("'")) fail(`unterminated string ${text}`, line);
  return text.slice(1, -1).replace(/''/g, "'");
}

function splitFlow(inner, line) {
  const items = [];
  let quote = null;
  let start = 0;
  for (let i = 0; i <= inner.length; i++) {
    const c = inner[i];
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ',' || i === inner.length) {
      items.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote) fail('unterminated string in a list', line);
  return items;
}

function scalar(body, line) {
  if (/^[&*!|>%@`]/.test(body))
    fail(`${body[0]} (anchors, tags, folded and literal blocks here) is not supported`, line);
  if (body.startsWith('"') || body.startsWith("'")) return unquote(body, line);
  if (body === '[]') return [];
  if (body === '{}') return {};
  if (body.startsWith('{')) fail('flow mappings are not supported', line);
  if (body.startsWith('[')) {
    if (!body.endsWith(']')) fail('a list that spans lines is not supported', line);
    const inner = body.slice(1, -1).trim();
    return inner === '' ? [] : splitFlow(inner, line).map((item) => scalar(item, line));
  }
  if (body === 'null' || body === '~') return null;
  if (body === 'true') return true;
  if (body === 'false') return false;
  if (/^-?(0|[1-9]\d*)$/.test(body)) return Number(body);
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(body)) return Number(body);
  return body;
}

const QUOTED_KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*))?$/;
const PLAIN_KEY = /^([^'"\s#[{&*!|>%@`-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

function splitKey(text) {
  const quoted = QUOTED_KEY.exec(text);
  if (quoted) return { key: unquote(quoted[1]), rest: quoted[2] ?? '' };
  const plain = PLAIN_KEY.exec(text);
  return plain ? { key: plain[1], rest: plain[2] ?? '' } : null;
}

function blockScalar(reader, parentIndent, header, line) {
  if (header.endsWith('+')) fail('keeping trailing blank lines (|+) is not supported', line);
  const lines = [];
  let blockIndent = null;
  while (reader.pos < reader.lines.length) {
    const raw = reader.lines[reader.pos];
    if (raw.trim() === '') {
      lines.push('');
      reader.pos++;
      continue;
    }
    const indent = indentOf(raw);
    if (indent <= parentIndent) break;
    blockIndent ??= indent;
    if (indent < blockIndent) break;
    lines.push(raw.slice(blockIndent));
    reader.pos++;
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.join('\n');
  return header === '|-' || body === '' ? body : `${body}\n`;
}

function value(reader, rest, indent, line) {
  const body = stripComment(rest).trim();
  if (body === '') {
    const following = next(reader);
    if (following && following.indent > indent) return node(reader, following.indent);
    if (following && following.indent === indent && isSequenceItem(following.text))
      return sequence(reader, indent);
    return null;
  }
  if (/^\|[-+]?$/.test(body)) return blockScalar(reader, indent, body, line);
  return scalar(body, line);
}

function mapping(reader, indent) {
  const out = {};
  for (;;) {
    const line = next(reader);
    if (!line || line.indent < indent) break;
    if (line.indent > indent) fail('unexpected indentation', line.pos);
    const split = isSequenceItem(line.text) ? null : splitKey(line.text);
    if (!split) fail(`not a "key: value" line: ${line.text}`, line.pos);
    if (split.key in out) fail(`duplicate key ${split.key}`, line.pos);
    reader.pos = line.pos + 1;
    out[split.key] = value(reader, split.rest, indent, line.pos);
  }
  return out;
}

function sequence(reader, indent) {
  const out = [];
  for (;;) {
    const line = next(reader);
    if (!line || line.indent < indent) break;
    if (line.indent > indent) fail('unexpected indentation', line.pos);
    if (!isSequenceItem(line.text)) break;
    const rest = line.text === '-' ? '' : line.text.slice(1).trimStart();
    const offset = indent + (line.text.length - rest.length);
    if (isSequenceItem(rest)) fail('a list inside a list item is not supported', line.pos);
    if (stripComment(rest).trim() === '') {
      reader.pos = line.pos + 1;
      const following = next(reader);
      out.push(following && following.indent > indent ? node(reader, following.indent) : null);
    } else if (splitKey(stripComment(rest).trim())) {
      // "- key: value" starts a mapping whose keys line up with the first one.
      reader.lines[line.pos] = ' '.repeat(offset) + rest;
      out.push(mapping(reader, offset));
    } else {
      reader.pos = line.pos + 1;
      out.push(value(reader, rest, indent, line.pos));
    }
  }
  return out;
}

function node(reader, minIndent) {
  const line = next(reader);
  if (!line || line.indent < minIndent) return null;
  return isSequenceItem(line.text) ? sequence(reader, line.indent) : mapping(reader, line.indent);
}

function document(lines) {
  lines.forEach((line, index) => {
    if (/^ *\t/.test(line)) fail('tabs cannot indent', index);
  });
  const reader = { lines: [...lines], pos: 0 };
  const first = next(reader);
  if (!first) return null;
  const result = node(reader, first.indent);
  const leftover = next(reader);
  if (leftover) fail(`unexpected content: ${leftover.text}`, leftover.pos);
  return result;
}

/** The documents (split on `---` lines) of a text, empty ones left out. */
export function parseYaml(text) {
  const documents = [];
  let lines = [];
  const flush = () => {
    const parsed = lines.some(significant) ? document(lines) : null;
    if (parsed !== null) documents.push(parsed);
    lines = [];
  };
  for (const line of String(text).split('\n')) {
    if (/^---\s*$/.test(line)) flush();
    else lines.push(line);
  }
  flush();
  return documents;
}
