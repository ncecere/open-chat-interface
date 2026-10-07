import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { validationFailed } from '../lib/errors.js';

/**
 * `sentences`: messages the schema gives a rule for people to read (such as
 * MESSAGE_TOO_LONG_TEXT). When one of them is why the body was refused, it is
 * the error's message, so a client that shows only the message says what to
 * do rather than "Request validation failed" (#247). The issues stay in the
 * details either way.
 */
export async function parseBody<T>(
  c: Context,
  schema: ZodType<T>,
  sentences: readonly string[] = [],
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw validationFailed('Request body must be valid JSON');
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const sentence = result.error.issues.find((issue) => sentences.includes(issue.message));
    throw validationFailed(sentence?.message ?? 'Request validation failed', result.error.issues);
  }
  return result.data;
}

export function parseQuery<T>(c: Context, schema: ZodType<T>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw validationFailed('Query validation failed', result.error.issues);
  }
  return result.data;
}
