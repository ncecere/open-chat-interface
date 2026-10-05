// Signed-in API sessions for setup and checks, and the import payload.

import { PERSON_PASSWORD } from '../../upgrade-test/lib.mjs';
import { WORDS } from '../../upgrade-test/seed.mjs';
import { base } from './context.mjs';

let sessions = 0;
/**
 * A signed-in person for setup and checks (the load has its own client), from
 * an address of its own: Better Auth allows three sign-ins per address in 10 s.
 */
export async function session(email, password = PERSON_PASSWORD) {
  const ip = `198.19.1.${++sessions}`;
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  if (!response.ok) throw new Error(`Sign-in for ${email} failed: HTTP ${response.status}`);
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0])
    .join('; ');
  return async (method, path, body) => {
    const headers = { cookie, origin: base, 'x-forwarded-for': ip };
    if (body !== undefined && !(body instanceof FormData))
      headers['content-type'] = 'application/json';
    const reply = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const text = await reply.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: reply.status, json, text };
  };
}

/** A Claude export (a bare JSON array) of `count` short conversations. */
export function claudeExport(count) {
  const conversations = [];
  for (let n = 0; n < count; n++) {
    const at = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
    conversations.push({
      uuid: `drill-${n}`,
      name: `Imported during the failover drill ${n}`,
      created_at: at,
      updated_at: at,
      chat_messages: [
        {
          uuid: `drill-${n}-q`,
          sender: 'human',
          text: `Question ${n} about ${WORDS[n % WORDS.length]}`,
          created_at: at,
        },
        { uuid: `drill-${n}-a`, sender: 'assistant', text: `Answer ${n}.`, created_at: at },
      ],
    });
  }
  return JSON.stringify(conversations);
}
