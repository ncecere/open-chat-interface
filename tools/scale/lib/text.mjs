/**
 * Synthetic text with a realistic word-frequency curve.
 *
 * The vocabulary is a few hundred common English words followed by tens of
 * thousands of invented ones, drawn with a Zipf distribution, so full-text
 * search sees what it sees in real use: a handful of words in almost every
 * message and a long tail of words in very few. The vocabulary depends only
 * on a fixed seed, never on the dataset seed, so the search terms the load
 * test uses mean the same thing for every profile.
 */
import { hashString, Rng } from './prng.mjs';

const COMMON = `the of and to a in is it you that for on with as are this be at have
from or one had by but not what all were we when your can said there use an each
which she do how their if will up other about out many then them these so some her
would make like him into time has look two more write go see number no way could
people my than first water been call who oil its now find long down day did get come
made may part over new sound take only little work know place year live me back give
most very after thing our just name good sentence man think say great where help
through much before line right too mean old any same tell boy follow came want show
also around form three small set put end does another well large must big even such
because turn here why ask went men read need land different home us move try kind
hand picture again change off play spell air away animal house point page letter
mother answer found study still learn should world high every near add food between
own below country plant last school father keep tree never start city earth eye
light thought head under story saw left few while along might close something seem
next hard open example begin life always those both paper together got group often
run important until children side feet car mile night walk white sea began grow took
river four carry state once book hear stop without second later miss idea enough eat
face watch far really almost let above girl sometimes mountain cut young talk soon
list song being leave family data project report table code function value error
model question summary draft email meeting budget plan review policy student course
research design team customer service system server request response update test
version release issue feature support account access file document analysis result
method process schedule deadline client contract invoice grant proposal lecture
exam paper chapter section figure source reference citation notes outline`
  .split(/\s+/)
  .filter(Boolean);

const ONSETS = ['b', 'br', 'c', 'ch', 'd', 'dr', 'f', 'g', 'gr', 'h', 'j', 'k', 'l', 'm', 'n'];
const ONSETS2 = ['p', 'pl', 'qu', 'r', 's', 'sh', 'st', 't', 'th', 'tr', 'v', 'w', 'z', 'sk'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ai', 'ea', 'io', 'ou', 'y'];
const CODAS = ['', '', 'n', 'r', 'l', 's', 'th', 'm', 'x', 'nd', 'st', 'rk'];

/** Size of the vocabulary: COMMON words first, then invented ones. */
export const VOCABULARY_SIZE = 30_000;
const SENTENCE_POOL = 40_000;
const ZIPF_EXPONENT = 1.05;

function buildVocabulary() {
  const rng = new Rng(hashString('oci-scale-vocabulary'), 1);
  const onsets = [...ONSETS, ...ONSETS2];
  const words = [...new Set(COMMON)];
  const seen = new Set(words);
  while (words.length < VOCABULARY_SIZE) {
    const syllables = rng.range(2, 4);
    let word = '';
    for (let s = 0; s < syllables; s++) {
      word += rng.pick(onsets) + rng.pick(VOWELS);
      if (s === syllables - 1) word += rng.pick(CODAS);
    }
    if (word.length < 5 || word.length > 14 || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

export const WORDS = buildVocabulary();

const CDF = (() => {
  const cdf = new Float64Array(WORDS.length);
  let sum = 0;
  for (let i = 0; i < WORDS.length; i++) {
    sum += 1 / (i + 2.7) ** ZIPF_EXPONENT;
    cdf[i] = sum;
  }
  for (let i = 0; i < cdf.length; i++) cdf[i] /= sum;
  return cdf;
})();

/** Index of a Zipf-distributed word. */
export function zipfIndex(rng) {
  const u = rng.float();
  let lo = 0;
  let hi = CDF.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (CDF[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function word(rng) {
  return WORDS[zipfIndex(rng)];
}

function capitalise(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const SENTENCES = (() => {
  const rng = new Rng(hashString('oci-scale-sentences'), 2);
  const out = new Array(SENTENCE_POOL);
  for (let i = 0; i < SENTENCE_POOL; i++) {
    const length = rng.range(5, 18);
    const parts = new Array(length);
    for (let w = 0; w < length; w++) parts[w] = word(rng);
    if (length > 9 && rng.chance(0.3)) parts[rng.range(3, length - 3)] += ',';
    const end = rng.chance(0.08) ? '?' : '.';
    out[i] = capitalise(parts.join(' ')) + end;
  }
  return out;
})();

export function sentence(rng) {
  return SENTENCES[rng.int(SENTENCE_POOL)];
}

function sentencesUpTo(rng, chars) {
  let out = sentence(rng);
  while (out.length < chars) out += ` ${sentence(rng)}`;
  return out;
}

export function title(rng) {
  const length = rng.range(2, 6);
  const parts = [];
  for (let i = 0; i < length; i++) {
    // Titles lean on mid-frequency words: "Budget draft for kestrel".
    parts.push(WORDS[Math.min(WORDS.length - 1, 30 + zipfIndex(rng))]);
  }
  return capitalise(parts.join(' ')).slice(0, 200);
}

const ASKS = [
  'Can you help me with this?',
  'Please summarise the main points.',
  'What would you change?',
  'Explain it like I am new to this.',
  'Rewrite this so it is clearer.',
  'Give me three options.',
  'What am I missing?',
  'Make it shorter.',
];

/** A person's message: usually a sentence or three, sometimes a pasted block. */
export function userText(rng) {
  const roll = rng.float();
  if (roll < 0.08) return `${sentencesUpTo(rng, rng.range(600, 3000))}\n\n${rng.pick(ASKS)}`;
  if (roll < 0.3) return `${sentencesUpTo(rng, rng.range(120, 400))} ${rng.pick(ASKS)}`;
  return sentencesUpTo(rng, rng.range(20, 160));
}

const LANGUAGES = ['typescript', 'python', 'sql', 'bash', 'json'];

function codeBlock(rng) {
  const language = rng.pick(LANGUAGES);
  const lines = rng.range(3, 14);
  const body = [];
  for (let i = 0; i < lines; i++) {
    const name = word(rng).replace(/[^a-z]/g, '') || 'value';
    const other = word(rng).replace(/[^a-z]/g, '') || 'item';
    body.push(
      language === 'sql'
        ? `select ${name}, count(*) from ${other} group by ${name};`
        : language === 'python'
          ? `${name} = compute_${other}(${rng.int(100)})`
          : language === 'bash'
            ? `${name} --${other} ${rng.int(1000)}`
            : language === 'json'
              ? `  "${name}": ${rng.int(10000)},`
              : `const ${name} = await ${other}(${rng.int(100)});`,
    );
  }
  return `\`\`\`${language}\n${body.join('\n')}\n\`\`\``;
}

function table(rng) {
  const columns = rng.range(2, 4);
  const header = Array.from({ length: columns }, () => capitalise(word(rng)));
  const rows = Array.from({ length: rng.range(2, 6) }, () =>
    Array.from({ length: columns }, (_, c) => (c === 0 ? word(rng) : String(rng.int(1000)))),
  );
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/**
 * An assistant reply in Markdown: paragraphs with headings, lists, code and
 * the occasional table, about `chars` long.
 */
export function assistantMarkdown(rng, chars) {
  const blocks = [];
  let length = 0;
  while (length < chars) {
    const roll = rng.float();
    let block;
    if (blocks.length > 0 && roll < 0.1) block = `## ${title(rng)}`;
    else if (roll < 0.25) {
      block = Array.from({ length: rng.range(2, 6) }, () => `- ${sentence(rng)}`).join('\n');
    } else if (roll < 0.32) block = codeBlock(rng);
    else if (roll < 0.35) block = table(rng);
    else block = sentencesUpTo(rng, rng.range(120, 600));
    blocks.push(block);
    length += block.length + 2;
  }
  return blocks.join('\n\n');
}

/** Visible reasoning summary, for replies from reasoning models. */
export function reasoningText(rng) {
  return `**Thinking about the request**\n\n${sentencesUpTo(rng, rng.range(150, 900))}`;
}

/**
 * The extracted text of a project file: paragraphs in which the project's
 * topic words recur, so keyword and meaning-based search have something to
 * find, about `chars` long.
 */
export function documentText(rng, topics, chars) {
  const paragraphs = [];
  let length = 0;
  while (length < chars) {
    let paragraph = '';
    const target = rng.range(300, 1400);
    while (paragraph.length < target) {
      let next = sentence(rng);
      if (topics.length > 0 && rng.chance(0.35)) {
        next = `${next.slice(0, -1)} ${rng.pick(topics)} ${word(rng)}.`;
      }
      paragraph += paragraph ? ` ${next}` : next;
    }
    paragraphs.push(rng.chance(0.1) ? `${title(rng)}\n\n${paragraph}` : paragraph);
    length += paragraph.length + 2;
  }
  return paragraphs.join('\n\n').slice(0, chars + 200);
}

/** Search terms by how common they are, for the keyword-search scenario. */
export function searchTerms() {
  const pick = (from, to, count) => {
    const out = [];
    const step = Math.max(1, Math.floor((to - from) / count));
    for (let i = from; i < to && out.length < count; i += step) {
      if (WORDS[i].length >= 3) out.push(WORDS[i]);
    }
    return out;
  };
  const medium = pick(800, 3000, 60);
  return {
    common: pick(40, 160, 40),
    medium,
    rare: pick(15_000, 30_000, 60),
    phrase: medium.slice(0, 30).map((w, i) => `${w} ${medium[(i * 7 + 3) % medium.length]}`),
  };
}

/**
 * Overlapping passages, as the API's chunker produces them: about 1,200
 * characters, overlapping by about 200, cut at a space. `content` is exactly
 * text.slice(start, end).
 */
export function chunkText(text, target = 1200, overlap = 200) {
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < 2000) {
    let end = Math.min(text.length, start + target);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + target / 2) end = space;
    }
    const content = text.slice(start, end);
    if (content.trim()) chunks.push({ start, end, content });
    if (end >= text.length) break;
    let next = end - overlap;
    const space = text.indexOf(' ', next);
    if (space > 0 && space < end) next = space + 1;
    start = Math.max(next, start + 1);
  }
  return chunks;
}
