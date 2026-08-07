import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { validationFailed } from '../lib/errors.js';

export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw validationFailed('Request body must be valid JSON');
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw validationFailed('Request validation failed', result.error.issues);
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
