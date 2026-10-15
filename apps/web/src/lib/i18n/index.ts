/**
 * Translations for the web app (#397). `useT()` in components, `translate()`
 * everywhere else, `format*` for dates, numbers, lists and sizes. How it works
 * and how to add a language: docs/dev/translations.md.
 */
export type { Catalog, MessageKey } from './catalog';
export {
  type DateStyle,
  type FormatOptions,
  formatDate,
  formatFileSize,
  formatList,
  formatNumber,
  formatRelativeTime,
} from './format';
export type { MessageParams } from './message';
export { I18nProvider, type LocaleContextValue, useLocale, useT } from './react';
export { matchBrowserLocale, resolveLocale } from './resolve';
export {
  activateLocale,
  getI18nState,
  type I18nState,
  initialLocale,
  type Translate,
  translate,
} from './state';
