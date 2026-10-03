// @vitest-environment happy-dom
import type { CatalogModel } from '@oci/shared';
import type { UIMessage } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  conversationChoice,
  forgetBrowserModel,
  startingModel,
} from '../../src/lib/starting-model';

const models = [
  { slug: 'first', isDefault: false },
  { slug: 'instance', isDefault: true },
  { slug: 'mine', isDefault: false },
] as CatalogModel[];

const message = (metadata: unknown) =>
  ({ id: 'm', role: 'user', parts: [], metadata }) as UIMessage;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('startingModel (v0.10)', () => {
  it('takes the first preference still in the catalog, then the instance default', () => {
    expect(startingModel(models, 'mine', 'first')?.slug).toBe('mine');
    expect(startingModel(models, 'retired', 'first')?.slug).toBe('first');
    expect(startingModel(models, null, undefined, '')?.slug).toBe('instance');
    expect(startingModel(models)?.slug).toBe('instance');
  });

  it('falls back to the first model without an instance default, and to nothing without models', () => {
    expect(startingModel(models.map((model) => ({ ...model, isDefault: false })))?.slug).toBe(
      'first',
    );
    expect(startingModel([], 'mine')).toBeNull();
  });
});

describe('conversationChoice', () => {
  it('reads the newest message that recorded a model, with its level if valid', () => {
    expect(
      conversationChoice([
        message({ modelSlug: 'old', effort: 'low' }),
        message({ modelSlug: 'new', effort: 'extreme' }),
        message({ status: 'complete' }),
        message(undefined),
      ]),
    ).toEqual({ modelSlug: 'new', effort: undefined });
    expect(conversationChoice([message({ modelSlug: 'm', effort: 'high' })])).toEqual({
      modelSlug: 'm',
      effort: 'high',
    });
    expect(conversationChoice([])).toEqual({ modelSlug: null, effort: undefined });
  });
});

describe('forgetBrowserModel', () => {
  it('removes the per-browser model from before v0.10, and tolerates blocked storage', () => {
    localStorage.setItem('oci.model', 'old');
    forgetBrowserModel();
    expect(localStorage.getItem('oci.model')).toBeNull();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => forgetBrowserModel()).not.toThrow();
  });
});
