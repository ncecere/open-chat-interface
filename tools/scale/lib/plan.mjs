/**
 * The shape of the dataset, decided once in the main thread and shared with
 * workers through SharedArrayBuffers: who owns which conversations, how many
 * messages each has, which projects and files exist. Per-entity attributes
 * (roles, flags, timestamps) are pure functions of the seed and an index, so
 * every thread derives the same answer without passing it around.
 */
import { allocate, entityId, hash01, hashString, Rng } from './prng.mjs';
import { WORDS } from './text.mjs';

export const DAY_MS = 86_400_000;
export const MAX_MESSAGES_PER_CONVERSATION = 600;
export const MAX_FILES_PER_PROJECT = 20;
export const MAX_PROJECTS_PER_PERSON = 10;
export const ADMIN_EMAIL = 'admin@scale.test';

const FIRST = ['Ada', 'Ben', 'Chen', 'Dana', 'Eli', 'Fatima', 'Gus', 'Hana', 'Ivan', 'Jo'];
const FIRST2 = ['Kemal', 'Lena', 'Mara', 'Nico', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq'];
const LAST = ['Abara', 'Berg', 'Costa', 'Dahl', 'Evans', 'Fischer', 'Garcia', 'Hughes', 'Ito'];
const LAST2 = ['Jensen', 'Kowalski', 'Lopez', 'Moreau', 'Nakamura', 'Okafor', 'Patel', 'Reyes'];
const FIRST_NAMES = [...FIRST, ...FIRST2];
const LAST_NAMES = [...LAST, ...LAST2];

export function ids(seedHash) {
  return {
    person: (i) => entityId(seedHash, 'person', i),
    account: (i) => entityId(seedHash, 'account', i),
    session: (i) => entityId(seedHash, 'session', i),
    preference: (i) => entityId(seedHash, 'preference', i),
    project: (i) => entityId(seedHash, 'project', i),
    thread: (i) => entityId(seedHash, 'thread', i),
    message: (i) => entityId(seedHash, 'message', i),
    file: (i) => entityId(seedHash, 'file', i),
    upload: (i) => entityId(seedHash, 'upload', i),
    share: (i) => entityId(seedHash, 'share', i),
    audit: (i) => entityId(seedHash, 'audit', i),
  };
}

/** Attributes of person `i`. Person 0 is the administrator the admin scenarios sign in as. */
export function personAttributes(seedHash, i, nowMs) {
  const roll = hash01(seedHash, 0x1001, i);
  let role = 'user';
  if (i === 0 || roll < 0.002) role = 'admin';
  else if (roll < 0.012) role = 'auditor';
  else if (roll < 0.04) role = 'restricted';
  const banned = role !== 'admin' && hash01(seedHash, 0x1002, i) < 0.004;
  // A third joined in the first weeks after launch, the rest over the year.
  const u = hash01(seedHash, 0x1003, i);
  const yearStart = nowMs - 365 * DAY_MS;
  const fraction = u < 0.35 ? (u / 0.35) * 0.06 : 0.06 + ((u - 0.35) / 0.65) * 0.93;
  const joinedMs =
    i === 0 ? yearStart - DAY_MS : Math.min(nowMs - DAY_MS, yearStart + fraction * 365 * DAY_MS);
  const first = FIRST_NAMES[Math.floor(hash01(seedHash, 0x1004, i) * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(hash01(seedHash, 0x1005, i) * LAST_NAMES.length)];
  return {
    role,
    banned,
    joinedMs,
    email: i === 0 ? ADMIN_EMAIL : `person${i}@scale.test`,
    name: i === 0 ? 'Scale Administrator' : `${first} ${last}`,
  };
}

/** Flags of conversation `c`. */
export function conversationFlags(seedHash, c) {
  const roll = hash01(seedHash, 0x2001, c);
  return {
    deleted: roll < 0.015,
    temporary: roll >= 0.015 && roll < 0.017,
    archived: roll >= 0.017 && roll < 0.077,
    pinned: hash01(seedHash, 0x2002, c) < 0.03,
    imported: hash01(seedHash, 0x2003, c) < 0.02,
    shared: hash01(seedHash, 0x2004, c) < 0.02,
  };
}

/** Three distinctive words that recur in a project's files. */
export function projectTopics(seedHash, p) {
  const out = [];
  for (let k = 0; out.length < 3 && k < 20; k++) {
    const index = 12_000 + Math.floor(hash01(seedHash, 0x3001 + k, p) * (WORDS.length - 12_000));
    if (!out.includes(WORDS[index])) out.push(WORDS[index]);
  }
  return out;
}

/**
 * One project in fifty holds large documents (handbooks, theses, books) whose
 * text cannot be included whole in a model's context, so a message in it is
 * answered from searched passages. Most projects fit whole and are never
 * searched (apps/api/src/services/chat/project-context.ts).
 */
export function isLargeProject(p) {
  return p % 50 === 0;
}

/** File states: what the background jobs still have to do for a file. */
export const FILE_STATE = {
  embedded: 0,
  /** Chunked, but without embeddings: work for `projects.embed-passages`. */
  indexed: 1,
  /** Not chunked yet: work for `projects.index-files`. */
  pending: 2,
  /** An image: nothing to extract. */
  noText: 3,
};

function shared(Type, length) {
  return new Type(new SharedArrayBuffer(Math.max(1, length) * Type.BYTES_PER_ELEMENT));
}

/**
 * Builds the dataset's structure. Exact totals from the profile; long-tailed
 * shares: conversations per person (Pareto), messages per conversation
 * (log-normal), files per project and passages per file (log-normal).
 */
export function buildPlan(dataset, seedHash, nowMs) {
  const { people: P, conversations: T, messages: M, projects: PR, projectFiles: F } = dataset;
  if (M < 2 * T) throw new Error('Every conversation needs at least two messages');
  const rng = new Rng(seedHash, hashString('plan'));
  const attributes = Array.from({ length: P }, (_, i) => personAttributes(seedHash, i, nowMs));

  // Conversations per person. Some people signed up and never chatted.
  const personWeights = new Float64Array(P);
  for (let i = 0; i < P; i++) {
    const idle = i !== 0 && hash01(seedHash, 0x1010, i) < 0.08;
    personWeights[i] = idle ? 0 : Math.min(60, rng.pareto(1.15));
  }
  const average = T / P;
  const perPersonMax = Math.max(Math.ceil(10 * average), Math.min(3000, T));
  const conversationsPerPerson = allocate(T, personWeights, rng, { max: perPersonMax });
  const personConvStart = shared(Int32Array, P + 1);
  for (let i = 0; i < P; i++)
    personConvStart[i + 1] = personConvStart[i] + conversationsPerPerson[i];
  const convOwner = shared(Int32Array, T);
  for (let i = 0; i < P; i++) {
    for (let c = personConvStart[i]; c < personConvStart[i + 1]; c++) convOwner[c] = i;
  }

  // Messages per conversation.
  const convWeights = new Float64Array(T);
  for (let c = 0; c < T; c++) convWeights[c] = rng.lognormal(0, 1.1);
  const messagesPerConversation = allocate(M, convWeights, rng, {
    min: 2,
    max: MAX_MESSAGES_PER_CONVERSATION,
  });
  const convMsgStart = shared(Int32Array, T + 1);
  for (let c = 0; c < T; c++) convMsgStart[c + 1] = convMsgStart[c] + messagesPerConversation[c];

  // Projects: about four in ten people who chat use them, more of the active ones.
  const projectWeights = new Float64Array(P);
  for (let i = 0; i < P; i++) {
    const a = attributes[i];
    const eligible = a.role !== 'restricted' && !a.banned && conversationsPerPerson[i] > 0;
    projectWeights[i] =
      eligible && hash01(seedHash, 0x1011, i) < 0.4 ? Math.sqrt(conversationsPerPerson[i]) : 0;
  }
  const eligibleCount = projectWeights.filter((w) => w > 0).length;
  if (PR > eligibleCount * MAX_PROJECTS_PER_PERSON) {
    throw new Error(`Too many projects (${PR}) for ${eligibleCount} people who use them`);
  }
  const projectsPerPerson = allocate(PR, projectWeights, rng, { max: MAX_PROJECTS_PER_PERSON });
  const personProjectStart = shared(Int32Array, P + 1);
  for (let i = 0; i < P; i++)
    personProjectStart[i + 1] = personProjectStart[i] + projectsPerPerson[i];
  const projectOwner = shared(Int32Array, PR);
  for (let i = 0; i < P; i++) {
    for (let p = personProjectStart[i]; p < personProjectStart[i + 1]; p++) projectOwner[p] = i;
  }

  // A third of a project user's conversations live in one of their projects.
  const convProject = shared(Int32Array, T);
  for (let c = 0; c < T; c++) {
    const owner = convOwner[c];
    const count = projectsPerPerson[owner];
    convProject[c] =
      count > 0 && hash01(seedHash, 0x2010, c) < 0.33
        ? personProjectStart[owner] + Math.floor(hash01(seedHash, 0x2011, c) * count)
        : -1;
  }

  // Files per project, passages per file, and what is left for the jobs.
  const fileWeights = new Float64Array(PR);
  for (let p = 0; p < PR; p++) fileWeights[p] = rng.lognormal(0, 0.9) * (isLargeProject(p) ? 4 : 1);
  const filesPerProject = allocate(F, fileWeights, rng, { max: MAX_FILES_PER_PROJECT });
  const projectFileStart = shared(Int32Array, PR + 1);
  for (let p = 0; p < PR; p++) projectFileStart[p + 1] = projectFileStart[p] + filesPerProject[p];
  const fileProject = shared(Int32Array, F);
  const fileChunks = shared(Int16Array, F);
  const fileState = shared(Uint8Array, F);
  let passages = 0;
  for (let p = 0; p < PR; p++) {
    for (let f = projectFileStart[p]; f < projectFileStart[p + 1]; f++) {
      fileProject[f] = p;
      const roll = hash01(seedHash, 0x3010, f);
      if (roll < 0.03) {
        fileState[f] = FILE_STATE.noText;
        fileChunks[f] = 0;
        continue;
      }
      fileChunks[f] = isLargeProject(p)
        ? Math.max(40, Math.min(300, Math.round(rng.lognormal(Math.log(110), 0.5))))
        : Math.max(1, Math.min(300, Math.round(rng.lognormal(Math.log(4), 0.9))));
      if (roll < 0.11) fileState[f] = FILE_STATE.pending;
      else if (roll < 0.2) fileState[f] = FILE_STATE.indexed;
      else fileState[f] = FILE_STATE.embedded;
      if (fileState[f] !== FILE_STATE.pending) passages += fileChunks[f];
    }
  }

  return {
    shared: {
      personConvStart,
      convOwner,
      convMsgStart,
      personProjectStart,
      projectOwner,
      convProject,
      projectFileStart,
      fileProject,
      fileChunks,
      fileState,
    },
    attributes,
    conversationsPerPerson,
    approxPassages: passages,
  };
}
