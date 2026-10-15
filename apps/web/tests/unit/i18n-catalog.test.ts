// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeMessage, parseMessage } from '../../src/lib/i18n/message-parse';
import { pseudoCatalog, pseudoMessage } from '../../src/lib/i18n/pseudo';
import { activateLocale, getI18nState, initialLocale, translate } from '../../src/lib/i18n/state';
import ar from '../../src/locales/ar.json';
import en from '../../src/locales/en.json';
import es from '../../src/locales/es.json';

beforeEach(async () => {
  localStorage.clear();
  await activateLocale('en');
});
afterEach(() => vi.restoreAllMocks());

describe('translate', () => {
  it('reads English and fills placeholders', () => {
    expect(translate('settings.language.title')).toBe('Language');
    expect(translate('language.optionBeta', { name: 'Español' })).toBe('Español (beta)');
  });

  it('counts plurals in English', () => {
    expect(translate('settings.language.available', { count: 1 })).toBe('1 language available');
    expect(translate('settings.language.available', { count: 3 })).toBe('3 languages available');
  });

  it('switches to Spanish once its catalog has loaded', async () => {
    await activateLocale('es');
    expect(getI18nState().locale).toBe('es');
    expect(translate('settings.language.title')).toBe('Idioma');
    expect(translate('settings.language.available', { count: 1 })).toBe('1 idioma disponible');
    expect(translate('settings.language.available', { count: 2 })).toBe('2 idiomas disponibles');
  });

  it('uses the six Arabic forms', async () => {
    await activateLocale('ar');
    const forms = [0, 1, 2, 3, 11, 100].map((count) =>
      translate('settings.language.available', { count }),
    );
    expect(new Set(forms).size).toBe(6);
    expect(forms[0]).toBe('لا توجد لغات متاحة');
    expect(forms[2]).toBe('لغتان متاحتان');
  });

  it('falls back to English for a key the locale lacks, and to the key for an unknown one', async () => {
    await activateLocale('es');
    const key = 'settings.language.title';
    const original = es[key];
    // @ts-expect-error simulating a catalog behind the source
    delete es[key];
    try {
      expect(translate(key)).toBe('Language');
    } finally {
      es[key] = original;
    }
    // @ts-expect-error not a key on purpose
    expect(translate('no.such.key')).toBe('no.such.key');
  });

  it('falls back to the English message when a translation does not parse, and never throws', async () => {
    await activateLocale('es');
    const key = 'settings.language.saved';
    const original = es[key];
    es[key] = 'Idioma {guardado';
    try {
      expect(translate(key)).toBe('Language saved.');
    } finally {
      es[key] = original;
    }
  });

  it('sets <html lang dir> and reports the direction', async () => {
    await activateLocale('ar');
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(getI18nState().dir).toBe('rtl');
    await activateLocale('en');
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('lets the last of two quick switches win, however the loads finish', async () => {
    const slow = activateLocale('ar');
    const fast = activateLocale('es');
    await Promise.all([slow, fast]);
    expect(getI18nState().locale).toBe('es');
  });

  it('keeps the current language when a catalog cannot be loaded', async () => {
    await expect(activateLocale('xx' as never)).resolves.toBeUndefined();
    expect(getI18nState().locale).toBe('en');
  });
});

describe('initialLocale', () => {
  it('is English with nothing cached, and the cached language otherwise', () => {
    expect(initialLocale({ pseudo: false })).toBe('en');
    localStorage.setItem('oci.locale', 'es');
    expect(initialLocale({ pseudo: false })).toBe('es');
    localStorage.setItem('oci.locale', 'klingon');
    expect(initialLocale({ pseudo: false })).toBe('en');
  });

  it('honours a pseudo-locale chosen on this device only when allowed', () => {
    localStorage.setItem('oci.locale', 'es');
    localStorage.setItem('oci.pseudoLocale', 'en-XA');
    expect(initialLocale({ pseudo: true })).toBe('en-XA');
    expect(initialLocale({ pseudo: false })).toBe('es');
  });
});

describe('the catalogs', () => {
  it('have the framework keys in every locale (the check script does this for the rest)', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
  });
});

describe('pseudo-locales', () => {
  it('en-XA accents, lengthens and keeps every argument and plural intact', () => {
    for (const [key, message] of Object.entries(en)) {
      const pseudo = pseudoMessage(message, 'en-XA');
      expect(() => parseMessage(pseudo), key).not.toThrow();
      expect(describeMessage(pseudo), key).toEqual(describeMessage(message));
    }
    const long = pseudoMessage('Settings and more things here', 'en-XA');
    expect(long.length).toBeGreaterThanOrEqual(
      Math.ceil('Settings and more things here'.length * 1.4),
    );
    expect(long).toMatch(/^\[.*\]$/);
    expect(long).not.toMatch(/[eao]/); // accented, not plain
  });

  it('ar-XB forces right-to-left runs of the English text', () => {
    const rtl = pseudoMessage('Hello {name}', 'ar-XB');
    expect(rtl).toContain('\u202E');
    expect(describeMessage(rtl)).toEqual(describeMessage('Hello {name}'));
  });

  it('keeps apostrophes and braces in the text from becoming syntax', () => {
    const pseudo = pseudoMessage(
      "It's '{literal}' and {n, plural, one {# it's} other {# its}}",
      'en-XA',
    );
    expect(describeMessage(pseudo).args.map((arg) => arg.name)).toEqual(['n']);
  });

  it('builds a whole catalog with the same keys', () => {
    expect(Object.keys(pseudoCatalog(en, 'en-XA')).sort()).toEqual(Object.keys(en).sort());
  });

  it('are shown by translate once activated', async () => {
    await activateLocale('en-XA');
    expect(translate('settings.language.title')).not.toBe('Language');
    expect(getI18nState().dir).toBe('ltr');
    await activateLocale('ar-XB');
    expect(getI18nState().dir).toBe('rtl');
  });
});
