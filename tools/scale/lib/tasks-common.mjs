// Constants and helpers shared by the row generators (tasks.mjs and tasks-*.mjs).

import { hash01 } from './prng.mjs';

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
/** Messages written before this many days ago predate v0.9's change sequence and keep NULL. */
export const CHANGE_SEQ_DAYS = 150;
export const CHANGE_SEQ_EPOCH = Date.UTC(2020, 0, 1);
export const CONTEXT_WINDOW_TOKENS = 128_000;

export const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
];

export const ATTACHMENT_KINDS = [
  { ext: 'png', mime: 'image/png', weight: 0.5, text: false },
  { ext: 'pdf', mime: 'application/pdf', weight: 0.3, text: true },
  { ext: 'txt', mime: 'text/plain', weight: 0.1, text: true },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    weight: 0.1,
    text: true,
  },
];

export const PROJECT_FILE_KINDS = [
  { ext: 'pdf', mime: 'application/pdf' },
  { ext: 'md', mime: 'text/markdown' },
  { ext: 'txt', mime: 'text/plain' },
  { ext: 'docx', mime: ATTACHMENT_KINDS[3].mime },
];

export function ip(seedHash, kind, index) {
  const v = Math.floor(hash01(seedHash, kind, index) * 0xffffff);
  return `10.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

export function pickWeighted(rng, items) {
  let u = rng.float();
  for (const item of items) {
    u -= item.weight;
    if (u < 0) return item;
  }
  return items[items.length - 1];
}

export function projectCreatedMs(seedHash, p, ownerJoinedMs, nowMs) {
  return ownerJoinedMs + hash01(seedHash, 0x3020, p) * (nowMs - ownerJoinedMs) * 0.7;
}
