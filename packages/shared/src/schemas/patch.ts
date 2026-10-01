import { z } from 'zod';

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;

export type PatchShape<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<WithoutDefault<T[K]>>;
};

/**
 * A partial-update schema for an object whose create schema carries defaults.
 *
 * Zod's `.partial()` keeps `.default()` wrappers, so an omitted field still
 * parses to its default. For a PATCH that turns "not sent" into "reset", and a
 * one-field change from the admin UI would overwrite stored values. Fields here
 * are optional with their defaults removed, so omitted means unchanged.
 */
export function patchSchema<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodObject<PatchShape<T>> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => {
      const base = field instanceof z.ZodDefault ? field.removeDefault() : field;
      return [key, (base as z.ZodType).optional()];
    }),
  );
  return z.object(shape) as unknown as z.ZodObject<PatchShape<T>>;
}
