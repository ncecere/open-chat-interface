import {
  patchSchema,
  updateInstanceSettingsSchema,
  updateModelSchema,
  upsertModelSchema,
} from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('partial-update schemas', () => {
  it('leave omitted fields absent instead of applying create defaults', () => {
    expect(updateModelSchema.parse({})).toEqual({});
    expect(updateModelSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(updateInstanceSettingsSchema.parse({ colorTheme: 'blue' })).toEqual({
      colorTheme: 'blue',
    });
  });

  it('still apply defaults when creating', () => {
    expect(
      upsertModelSchema.parse({
        providerId: 'provider',
        upstreamModelId: 'model',
        slug: 'model',
        displayName: 'Model',
      }),
    ).toMatchObject({ enabled: true, isDefault: false, capabilities: [], sortOrder: 0 });
  });

  it('keep field validation for values that are sent', () => {
    expect(() => updateModelSchema.parse({ slug: 'Not Valid' })).toThrow();
    expect(() => updateInstanceSettingsSchema.parse({ sessionLifetimeDays: 0 })).toThrow();
    const report = patchSchema(z.object({ windowDays: z.number().int().min(1).default(30) }));
    expect(report.parse({})).toEqual({});
    expect(() => report.parse({ windowDays: 0 })).toThrow();
  });
});
