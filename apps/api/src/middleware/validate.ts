import type { Context } from 'hono';
import type { ZodType, z } from 'zod';
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

/**
 * The body of a PATCH or PUT whose fields are all optional. `{}`, or a body
 * with no field the route knows (`{"foo":1}`: unknown keys are dropped), parsed
 * to an empty change, and the route's `.set(patch)` threw "No values to set":
 * a 500 that paged whoever watches 5xx for a mistake in the request (#341).
 * It is a 422 that names the fields to send. Use it for every all-optional
 * body that is written to a row; routes whose schema already requires a field
 * need not.
 */
export async function parseChanges<T extends z.ZodRawShape>(
  c: Context,
  schema: z.ZodObject<T>,
): Promise<z.infer<z.ZodObject<T>>> {
  const message = `Send at least one change: ${Object.keys(schema.shape).join(', ')}.`;
  return parseBody(
    c,
    schema.refine((body) => Object.values(body).some((value) => value !== undefined), { message }),
    [message],
  );
}

export function parseQuery<T>(c: Context, schema: ZodType<T>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw validationFailed('Query validation failed', result.error.issues);
  }
  return result.data;
}
