import en from '~/locales/en.json';

/** A loaded catalog: flat keys to ICU-subset messages. */
export type Catalog = Readonly<Record<string, string>>;

/**
 * Every key `en.json` has. `t('typo.key')` is a type error, and so is a
 * locale loader in `locales/index.ts` that lacks one (`pnpm typecheck`).
 */
export type MessageKey = keyof typeof en;

/** English is the source: always complete, always loaded, the fallback for every key. */
export const sourceCatalog: Catalog = en;
