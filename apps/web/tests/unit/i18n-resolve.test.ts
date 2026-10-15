import { SUPPORTED_LOCALES } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { matchBrowserLocale, resolveLocale } from '../../src/lib/i18n/resolve';
import {
  availableLocales,
  LOCALES,
  PSEUDO_LOCALES,
  pseudoLocalesAvailable,
} from '../../src/locales';

// Order: the person's saved language, the instance default, the browser's
// languages matched to the enabled ones, English.

const enabled = ['en', 'es'];

describe('the registry', () => {
  it('lists exactly the languages the API accepts, with the beta ones flagged', () => {
    expect(Object.keys(LOCALES).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(LOCALES.en.beta).toBe(false);
    expect(LOCALES.es.beta).toBe(true);
    expect(LOCALES.ar.beta).toBe(true);
    expect(LOCALES.ar.rtl).toBe(true);
    expect(LOCALES.en.rtl).toBe(false);
  });

  it('has the two pseudo-locales, the second one right-to-left', () => {
    expect(PSEUDO_LOCALES['en-XA'].rtl).toBe(false);
    expect(PSEUDO_LOCALES['ar-XB'].rtl).toBe(true);
  });

  it('offers pseudo-locales outside production or with the flag, never otherwise', () => {
    expect(pseudoLocalesAvailable({ MODE: 'development' })).toBe(true);
    expect(pseudoLocalesAvailable({ MODE: 'test' })).toBe(true);
    expect(pseudoLocalesAvailable({ MODE: 'production' })).toBe(false);
    expect(pseudoLocalesAvailable({ MODE: 'production', VITE_OCI_PSEUDO_LOCALES: '1' })).toBe(true);
    expect(pseudoLocalesAvailable({ MODE: 'production', VITE_OCI_PSEUDO_LOCALES: '0' })).toBe(
      false,
    );
  });

  it('lists the enabled languages (English always) and the pseudo ones only when allowed', () => {
    expect(availableLocales(['es'], { pseudo: false })).toEqual(['en', 'es']);
    expect(availableLocales(undefined, { pseudo: false })).toEqual(['en']);
    expect(availableLocales(['ar', 'es', 'zz'], { pseudo: false })).toEqual(['en', 'es', 'ar']);
    expect(availableLocales(['en'], { pseudo: true })).toEqual(['en', 'en-XA', 'ar-XB']);
  });
});

describe('matchBrowserLocale', () => {
  it('matches a full tag, then its language', () => {
    expect(matchBrowserLocale(['es'], enabled)).toBe('es');
    expect(matchBrowserLocale(['es-MX'], enabled)).toBe('es');
    expect(matchBrowserLocale(['ES-419'], enabled)).toBe('es');
    expect(matchBrowserLocale(['en-GB'], enabled)).toBe('en');
  });

  it('takes the first language the person listed that is enabled', () => {
    expect(matchBrowserLocale(['fr-FR', 'es-ES', 'en'], enabled)).toBe('es');
    expect(matchBrowserLocale(['en-US', 'es'], enabled)).toBe('en');
    // Arabic is installed but not enabled on this instance.
    expect(matchBrowserLocale(['ar-EG', 'es'], enabled)).toBe('es');
  });

  it('is null when nothing matches', () => {
    expect(matchBrowserLocale(['fr', 'de'], enabled)).toBeNull();
    expect(matchBrowserLocale([], enabled)).toBeNull();
  });
});

describe('resolveLocale', () => {
  const base = { enabled, browser: ['es'], pseudo: false } as const;

  it("uses the person's saved language first", () => {
    expect(resolveLocale({ ...base, saved: 'en', instanceDefault: 'es' })).toBe('en');
    expect(resolveLocale({ ...base, saved: 'es', instanceDefault: null, browser: ['en'] })).toBe(
      'es',
    );
  });

  it('then the instance default, then the browser, then English', () => {
    expect(resolveLocale({ ...base, saved: null, instanceDefault: 'en', browser: ['es'] })).toBe(
      'en',
    );
    expect(resolveLocale({ ...base, saved: null, instanceDefault: null })).toBe('es');
    expect(resolveLocale({ ...base, saved: null, instanceDefault: null, browser: ['fr'] })).toBe(
      'en',
    );
    expect(resolveLocale({ enabled: undefined, pseudo: false })).toBe('en');
  });

  it('falls back without error when the saved language is no longer enabled', () => {
    expect(resolveLocale({ ...base, saved: 'ar', instanceDefault: 'es' })).toBe('es');
    expect(resolveLocale({ ...base, saved: 'ar', instanceDefault: null, browser: ['fr'] })).toBe(
      'en',
    );
  });

  it('ignores a default that is not enabled, and tags it does not know', () => {
    expect(resolveLocale({ ...base, saved: 'zz', instanceDefault: 'ar' })).toBe('es');
    expect(resolveLocale({ ...base, saved: 'zz', instanceDefault: 'qq', browser: [] })).toBe('en');
  });

  it('honours a pseudo-locale chosen on this device only when they are available', () => {
    expect(resolveLocale({ ...base, saved: 'es', pseudo: true, pseudoChoice: 'ar-XB' })).toBe(
      'ar-XB',
    );
    expect(resolveLocale({ ...base, saved: 'es', pseudo: false, pseudoChoice: 'ar-XB' })).toBe(
      'es',
    );
    // A pseudo-locale is never a saved language.
    expect(resolveLocale({ ...base, saved: 'en-XA', pseudo: true })).toBe('es');
  });
});
