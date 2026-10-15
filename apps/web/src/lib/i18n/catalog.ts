// A TYPE-ONLY import: it types the keys and puts nothing in the bundle. The
// catalogs themselves, English included, are dynamic imports (`~/locales`), so
// the strings are never part of the initial JavaScript.
import type en from '~/locales/en.json';

/** A loaded catalog: flat keys to ICU-subset messages. */
export type Catalog = Readonly<Record<string, string>>;

/**
 * Every key `en.json` has. `t('typo.key')` is a type error, and so is a
 * locale loader in `locales/index.ts` that lacks one (`pnpm typecheck`).
 */
export type MessageKey = keyof typeof en;
