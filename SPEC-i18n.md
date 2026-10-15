# Spec: i18n (#397)

Module of [SPEC.md](SPEC.md) (v0.14). Migration `0055_user_locale` (additive). Depends on the other features
(strings are extracted last, so no module fights over every file).

## Objective

Institutions serve people in many languages. Give the web app a translation framework, per-person and
per-instance language, and right-to-left layout, translate the end-user surfaces, and make adding a language a
documented, checked contribution. **No translation library is added**: `Intl` plus a small typed catalog.

## Decisions

- **Locales**: `en` is the source and always complete. `es` and `ar` are machine-drafted and shown as *beta*
  (the picker says "Español (beta)"; the docs invite native review). Pseudo-locales `en-XA` (accented, about
  40% longer) and `ar-XB`-style forced-RTL mirroring exist for tests and are listed only in non-production
  builds or with `VITE_OCI_PSEUDO_LOCALES=1`.
- **Scope**: every end-user surface (sign-in, sign-up, accept-invite, reset, verification, MFA, onboarding, chat
  home and thread, composer, message actions, model picker, approvals, artifacts, sidebar, command palette,
  search, projects and sharing, settings, share pages, errors, empty states, toasts, `aria-label`, `title`,
  `placeholder`, `alt`, document titles). **The admin console stays English** and the docs say so. Server text
  (emails, exports, API `message`) stays English in v0.14; the web app translates API errors by their `code`
  when the catalog has one and shows the server text otherwise.
- **Catalogs**: `apps/web/src/locales/<tag>.json`, flat keys, ICU-subset messages
  (`{name}`, `{count, plural, one {…} other {…}}`, `{n, number}`, `{d, date, short}`) parsed by a small module
  with `Intl.PluralRules`/`NumberFormat`/`DateTimeFormat`; keys are typed from `en.json` so a missing key fails
  `pnpm typecheck`. Non-English catalogs load lazily (dynamic import); the base bundle must not grow by more than
  8 kB gzip (`apps/web/scripts/check-route-chunks.mjs` is the gate).
- **Resolution order**: the person's saved language, else the instance default (Admin → Branding/General,
  `language: { default, enabled[] }`, an instance setting, no migration), else the browser's languages matched
  to the enabled ones, else `en`. Saved language is a nullable `locale` column on the personal-preferences
  table (migration `0055`; `packages/db/src/schema/usage.ts`, the table that holds `defaultModelSlug`); a v0.13
  replica ignores it.

## Acceptance criteria

1. `useT()` / `t(key, params)` and a non-React `translate()` exist, tested for placeholders, plurals in `en`,
   `es` and `ar` (six forms), missing-key fallback to `en`, and no throwing on a bad message.
2. All dates, times, numbers, relative times and lists in the web app go through one formatter module that uses
   the current locale (replace the existing `toLocale*`/`Intl` call sites; a lint check forbids new ones).
3. `<html lang dir>` follows the locale; Tailwind physical utilities (`ml-`, `mr-`, `pl-`, `pr-`, `left-`,
   `right-`, `text-left`, `text-right`, `border-l/r`, `rounded-l/r`) are replaced by logical ones (`ms-`, `me-`,
   `ps-`, `pe-`, `start-`, `end-`, `text-start`, `text-end`, `border-s/e`, `rounded-s/e`); direction-bearing
   icons (chevrons, arrows, back, send) mirror in RTL and others do not; user-generated text (messages, titles,
   file names) gets `dir="auto"`, code blocks stay left-to-right, the composer is `dir="auto"`.
4. **Completeness is enforced**: `scripts/check-i18n.mjs` (run by `pnpm lint` or CI) fails when a migrated
   directory contains a JSX text literal or a listed attribute literal that is not a `t()` call (with an
   allowlist file, each entry justified), when a locale lacks a key `en` has, has an extra key, or has
   placeholders or plural categories that differ from `en`.
5. Language picker in **Settings → Customization** (saves to the server, applies at once, persists across
   sessions and devices); admin default and enabled list; a person whose language is no longer enabled falls back
   without error.
6. **RTL is checked visually and mechanically** in `ar`: no horizontal overflow at 320, 768 and 1280 px on the
   sign-in page, chat home, a conversation with Arabic and English mixed, settings and a share page; the sidebar
   is on the right; keyboard focus order follows reading order; axe passes in `ar`.
7. `es` and `ar` catalogs complete for the migrated scope and flagged beta in `locales/index.ts`.
8. Docs: `docs/dev/translations.md` (adding a language, the checks, how to review a beta catalog), `docs/user`
   (choosing a language), `docs/admin` (default and enabled languages, the admin console is English), docs site
   in the release step.

## Work breakdown (build order inside the module)

T1 framework, formatter, picker, migration, setting, RTL base (`dir`, logical utilities across the app), the
check script with an empty migrated list. T2..Tn extract one area per agent in disjoint directories (auth;
chat; sidebar and palette; projects and sharing; settings; shared components and errors), each adds its keys to
`en.json` under its own prefix and to the migrated list. Tlast `es` and `ar` drafts, RTL review, screenshots.

## Testing strategy (red first)

Unit (formatter, parser, resolver, check script), component tests per extracted area rendered in `en`, `es`,
`ar` and `en-XA`, live (preference saved and read back, instance setting validation, 403 for others'
preferences), Playwright per locale (the RTL assertions above, language switch persists), bundle size gate.

## Boundaries

Always: `en` complete before any other locale; user text never translated or reordered. Never: ship `es` or
`ar` without the beta label; add a dependency; translate server data (model names, instance branding text).
