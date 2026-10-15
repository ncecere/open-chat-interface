import {
  DEFAULT_LANGUAGE_SETTINGS,
  isSupportedLocale,
  normalizeLanguageSettings,
  SUPPORTED_LOCALES,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { describe, expect, it } from 'vitest';

/**
 * The instance's language setting (v0.14, #397) is JSON read from storage that
 * a newer or older release may have written, so reading never throws and
 * always yields a usable value.
 */
describe('normalizeLanguageSettings', () => {
  it('is English only for an instance that never saved it', () => {
    expect(normalizeLanguageSettings(undefined)).toEqual(DEFAULT_LANGUAGE_SETTINGS);
    expect(normalizeLanguageSettings({})).toEqual({ default: null, enabled: ['en'] });
    expect(normalizeLanguageSettings(null)).toEqual({ default: null, enabled: ['en'] });
    expect(normalizeLanguageSettings('es')).toEqual({ default: null, enabled: ['en'] });
  });

  it('always enables English and keeps the registry order', () => {
    expect(normalizeLanguageSettings({ enabled: ['ar', 'es'] }).enabled).toEqual([
      'en',
      'es',
      'ar',
    ]);
    expect(normalizeLanguageSettings({ enabled: ['es', 'es'] }).enabled).toEqual(['en', 'es']);
  });

  it('drops languages it does not know, and a default that is not enabled', () => {
    expect(normalizeLanguageSettings({ enabled: ['es', 'fr', 5, null] }).enabled).toEqual([
      'en',
      'es',
    ]);
    expect(normalizeLanguageSettings({ default: 'fr', enabled: ['es'] }).default).toBeNull();
    expect(normalizeLanguageSettings({ default: 'ar', enabled: ['es'] }).default).toBeNull();
    expect(normalizeLanguageSettings({ default: 'es', enabled: ['es'] }).default).toBe('es');
    expect(normalizeLanguageSettings({ default: 'en', enabled: [] }).default).toBe('en');
    expect(normalizeLanguageSettings({ enabled: 'es' }).enabled).toEqual(['en']);
  });
});

describe('the supported locales', () => {
  it('are the three the web app registers, and nothing else is accepted', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['en', 'es', 'ar']);
    expect(isSupportedLocale('es')).toBe(true);
    for (const value of ['en-XA', 'ES', 'fr', '', null, 3])
      expect(isSupportedLocale(value)).toBe(false);
  });
});

describe('updateInstanceSettingsSchema language', () => {
  const parse = (language: unknown) => updateInstanceSettingsSchema.safeParse({ language });

  it('takes either part alone', () => {
    expect(parse({ default: 'es' }).success).toBe(true);
    expect(parse({ default: null }).success).toBe(true);
    expect(parse({ enabled: ['en', 'es'] }).success).toBe(true);
  });

  it('refuses unknown languages, an empty list, pseudo-locales and unknown fields', () => {
    expect(parse({ enabled: ['fr'] }).success).toBe(false);
    expect(parse({ enabled: [] }).success).toBe(false);
    expect(parse({ default: 'ar-XB' }).success).toBe(false);
    expect(parse({ other: 1 }).success).toBe(false);
  });
});
