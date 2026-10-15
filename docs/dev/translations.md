# Translations

The web app can be shown in more than one language and in right-to-left
layouts (v0.14, #397). There is **no translation library**: `Intl` plus a small
typed catalog (`apps/web/src/lib/i18n/`). This page is for people who change
strings or add a language. People who only want to use a language: see
[Settings](../user/settings.md#language); administrators: see
[Instance settings](../admin/instance-settings.md#language).

What is translated: every surface people chat in (sign-in, chat, settings,
sharing, errors, `aria-label`, `title`, `placeholder`, `alt`, document titles).
What is not: the **administration console stays in English**, and so do server
text (emails, exports, the API's `message`), model names and the instance's
own branding text. User text (messages, titles, file names) is never translated
or reordered.

## Languages

| Tag | State | Direction |
| --- | --- | --- |
| `en` | The source. Always complete, and always loaded (as a lazy chunk, next to any other language, as its fallback). | left to right |
| `es` | **Beta**: machine-drafted, not reviewed by a native reader. | left to right |
| `ar` | **Beta**: machine-drafted, not reviewed by a native reader. | right to left |
| `en-XA`, `ar-XB` | Pseudo-locales, generated from `en.json` when chosen (nothing to commit). Offered only outside production builds, or in a production build made with `VITE_OCI_PSEUDO_LOCALES=1`. | left to right, right to left |

`en-XA` accents every letter, makes text about 40% longer and puts it in
`[brackets]`: untranslated English stands out as plain letters, a clipped label
loses its `]`, and a layout that only fits English breaks. `ar-XB` forces the
English text into right-to-left runs, so the mirrored layout can be looked at
without reading Arabic. A pseudo-locale is chosen in the language picker, kept
on that device and never saved to the server.

The registry is `apps/web/src/locales/index.ts`; the list the API accepts is
`SUPPORTED_LOCALES` in `packages/shared/src/locales.ts`; a unit test keeps them
equal.

## Using it

```tsx
import { formatDate, translate, useT } from '~/lib/i18n';

function Greeting({ name, count }: { name: string; count: number }) {
  const t = useT(); // re-renders this component when the language changes
  return <p>{t('chat.home.greeting', { name })}</p>;
}

// Anywhere that is not a component: a toast, a hook, a document title.
toast.success(translate('settings.language.saved'));
```

`t(key, params)` types `key` from `apps/web/src/locales/en.json` (through a
type-only import, `import type en from './en.json'`: no strings reach the
bundle through it), so a misspelt key fails `pnpm typecheck`. A key missing from the current language
falls back to English, and a key missing everywhere shows the key; neither
throws, and neither does a message that does not parse (the English message is
used). Parameters are inserted as text and never read as message syntax, so
user text in `{name}` is safe.

### Messages

A subset of ICU MessageFormat, parsed by `lib/i18n/message-parse.ts`:

| Syntax | Meaning |
| --- | --- |
| `Hello {name}` | an argument |
| `{n, number}`, `{n, number, percent}`, `{n, number, integer}` | a number in the language |
| `{d, date, short}`, `{d, date, long}`, `{d, date, time}` | a date or a time (a `Date`, a timestamp or an ISO string) |
| `{count, plural, one {# file} other {# files}}` | a plural by the language's rules (`Intl.PluralRules`); `#` is the count |
| `{n, plural, =0 {none} one {# item} other {# items}}`, `offset:1` | exact matches and an offset |

A lone apostrophe is text (`It's`); `''` is one apostrophe; `'{` starts quoted
text up to the next `'`.

### Dates, numbers, lists

Everything a person reads as a date, time, number, relative time, list or file
size goes through `lib/i18n/format.ts` (`formatDate`, `formatNumber`,
`formatRelativeTime`, `formatList`, `formatFileSize`), which uses the language
the app is showing. Do not call `toLocaleString`, `toLocaleDateString`,
`toLocaleTimeString` or `new Intl.NumberFormat/DateTimeFormat/RelativeTimeFormat/ListFormat/DisplayNames`
anywhere else; the check below fails on it.

### Which language is shown

In order: the person's saved language (`user_preference.locale`, set in
Settings → Customization), the instance default (Admin → Branding), the
browser's languages matched to the languages the instance enabled
(`es-MX` matches `es`), `en`. A saved or default language the instance no
longer enables is skipped without any error and the saved choice is kept.
`I18nProvider` (in `main.tsx`) decides it once the person and the instance
settings are known, loads the catalog with a dynamic import, switches in one
step, and sets `<html lang dir>`. The language shown last time is remembered
in `localStorage` (`oci.locale`) so a reload does not flash English.

### Loading

**Every catalog, English included, is a dynamic import**: a chunk of its own,
never part of the initial JavaScript, however many strings it holds. So that
nothing is painted as keys, `main.tsx` awaits `activateLocale(initialLocale())`
before the first `render` (one small request; nothing is shown meanwhile), and
`I18nProvider` renders nothing until a catalog is loaded, as a net for any
other entry point. A language is always fetched together with English (the
fallback for a key it lacks). A catalog that cannot be fetched (offline, a
stale chunk after a deploy) never throws: the first load falls back to
English, a later switch keeps the language already showing, and if English is
unreachable too `translate()` returns the key. `translate()` works anywhere
once `activateLocale` has resolved; before that it returns the key.

The loaded catalogs live in a map on `globalThis` (`__ociI18nCatalogs`), so a
re-evaluated copy of `lib/i18n/state.ts` (hot reload, `vi.resetModules()`)
finds them instead of showing keys.

### In unit tests

`tests/unit/setup.ts` (the vitest `setupFiles` in `vite.config.ts`) awaits
`activateLocale('en')` before each test file, so **`useT()` and `translate()`
return the real English strings in any test, with nothing to await and no
provider to mount**. Assert on the English text. A test of another language
awaits `activateLocale('es')` itself (and `activateLocale('en')` in
`beforeEach`/`afterEach` if it must not leak). `<html lang dir>` is set by it,
so a test that looks for "no `dir` on this element" must say
`:not(html)`. A test of the loader itself (a cold start, a failed fetch) is
`tests/unit/i18n-loading.test.tsx`.

## Adding a language

1. Add the tag to `SUPPORTED_LOCALES` (`packages/shared/src/locales.ts`).
2. Add `apps/web/src/locales/<tag>.json` with **every key `en.json` has**.
3. Add it to `LOCALES` in `apps/web/src/locales/index.ts`: `intl` (the `Intl`
   tag), `rtl`, `beta: true` and a `load` that imports the JSON. Add
   `language.name.<tag>` to **every** catalog (the language's name in its own
   language, the same in all of them): the picker shows it.
4. `pnpm lint` (runs `node scripts/check-i18n.mjs`) and `pnpm typecheck`.
5. Start it as **beta**. The picker then says "Name (beta)" and the admin page
   says it is unreviewed. Administrators turn a language on in Admin →
   Branding → Language; none but English is on by default.

## The checks

`scripts/check-i18n.mjs` runs in `pnpm lint` (so in CI), tested by
`scripts/check-i18n.test.mjs`. It fails on:

- **A catalog problem**: a locale missing a key `en` has, or having an extra
  one; placeholders that differ from `en` (name or kind: `{n}` against
  `{n, number}` counts); a plural whose categories are not the ones the
  language needs; a message that does not parse; a key that is not
  `area.name` in camelCase.
- **A literal in a migrated directory**: JSX text, or a string given to
  `aria-label`, `title`, `placeholder` or `alt`, that is not a `t()` call,
  in a directory listed in `scripts/i18n/migrated.json`. An empty `alt=""` and
  text without letters (`—`, `/`) are fine. What stays a literal on purpose
  (a variable name, a brand mark) goes in `scripts/i18n/literal-allowlist.json`
  with a reason; an entry without one, or one that no longer matches, fails.
- **A new locale-formatting call** outside `lib/i18n/format.ts`. The existing
  75 in 40 files are counted in `scripts/i18n/format-allowlist.json`, each
  justified `step 2`. The count only goes down: converting a file means
  lowering or removing its entry, and the check fails until you do.

Plural categories are compared with what **the language** needs (CLDR, from
`Intl.PluralRules`), not with `en`: English has `one` and `other`, Spanish
`one`, `many` and `other`, Arabic `zero`, `one`, `two`, `few`, `many` and
`other`. A translation with fewer is missing forms; one with more has forms no
number ever selects. `=0` and other exact matches may be added freely.

## Converting an area (the work after the framework)

1. Pick a directory (`apps/web/src/components/auth`, say). Replace every
   visible string with `t('auth.signIn.submit')`. Name keys `area.component.what`
   in camelCase, under the prefix of the area, in `en.json`.
2. Replace the `toLocale*` and `Intl` calls in it with the formatter, and lower
   `scripts/i18n/format-allowlist.json`.
3. Add the directory to `scripts/i18n/migrated.json`. From then on the check
   keeps it migrated.
4. Add the keys to `es.json` and `ar.json` too (a draft is fine, it is beta),
   or `pnpm lint` fails.
5. Convert physical Tailwind utilities in the same files to logical ones so the
   page mirrors (see [Right to left](#right-to-left)); `pnpm lint` fails on one.
6. Test the component rendered in `en`, `es`, `ar` and `en-XA` (`activateLocale`
   from `lib/i18n/state`).

Do not translate: model names, the instance's branding text, server data, user
text.

## Right to left

A page mirrors when its spacing, alignment and positions are **logical**
(start and end), not physical (left and right). `scripts/check-logical-css.mjs`
(in `pnpm lint`, tested by `scripts/check-logical-css.test.mjs`) fails on a new
physical one anywhere under `apps/web/src`, the administration console included
(it stays English but must not be half mirrored):

| Not this | This |
| --- | --- |
| `ml-` `mr-` `pl-` `pr-` | `ms-` `me-` `ps-` `pe-` |
| `left-` `right-` | `start-` `end-` |
| `text-left` `text-right` | `text-start` `text-end` |
| `border-l` `border-r` (and `-*`) | `border-s` `border-e` |
| `rounded-l` `-r` `-tl` `-tr` `-bl` `-br` | `rounded-s` `-e` `-ss` `-se` `-es` `-ee` |
| `float-left`, `scroll-ml-` | `float-start`, `scroll-ms-` |
| `marginLeft`, `paddingRight`, `textAlign: 'left'`, `left` in a `style` | `marginInlineStart`, `paddingInlineEnd`, `'start'`, `insetInlineStart` |
| `margin-left:` in CSS | `margin-inline-start:` |

`space-x-*`, `divide-x-*` and `gap-*` are already logical in Tailwind 4.3.

- **A translate** (`-translate-x-1/2` to centre, a slide in or out) needs an
  `rtl:` counterpart in the same string: `start-1/2 -translate-x-1/2
  rtl:translate-x-1/2`. `translate-x-0` is the same both ways. A gradient or
  mask toward `left`/`right` gets an `rtl:` one turned round.
- **Icons that point** mirror: `rtl:-scale-x-100` on a chevron, arrow, back,
  send, sign-out, sidebar toggle or open-in-new (the list is `DIRECTION_ICONS` in
  the check, which fails on one without an `rtl:` class). One that also
  rotates (a disclosure chevron: `rotate-90` open) uses `rtl:rotate-180` for
  the closed state instead: a flipped chevron turned 90 degrees points up. Icons
  that do not point (plus, clock, play, refresh) are not mirrored.
- **Do not use `:dir()`** in a class or a stylesheet: the CSS build (Tailwind's
  browser floor is Chrome 111, `:dir()` is 120) rewrites it to `:lang()`, which
  matches the language of the page, not the direction of the text. Use
  `[dir=rtl]` (the app writes `dir` on lists and quotes) or `rtl:`. The check
  fails on it.
- **User text gets `dir="auto"`** where it is rendered (a title, a file name, a
  project name, a memory, a snippet); inside a translated sentence wrap it in
  `<bdi>` so the sentence is not reordered by it. **Code stays left to right**:
  `<pre dir="ltr">`; Markdown code blocks and inline code are `dir="ltr"` and
  `unicode-bidi: isolate` (`markdown.tsx`, `markdown-direction.ts`). Key
  combinations (`Ctrl K`) are `dir="ltr"`. The composer is `dir="auto"`.
- **Keys and geometry that mean a side** follow the page: in right-to-left Left
  is "next" in a tab strip, the artifact panel is docked on the left and its
  separator widens with Right, a submenu opens with Left (Radix reads `dir` from
  a prop, so `DropdownMenu` and `SelectRoot` in `components/ui` pass it), and
  `scrollLeft` is zero at the start and counts down. Use `useLocale().dir` or
  `getComputedStyle(element).direction`.
- **What must stay physical** is listed with a reason in
  `scripts/i18n/physical-css-allowlist.json` (a card placed against a window
  edge it was measured against; undoing Streamdown's own physical padding). The
  count per file only goes down.

## Reviewing a beta catalog

A reviewer needs to read the language, not to program.

1. Run the app (or an [environment](../../AGENTS.md)), sign in, and in
   Settings → Customization choose the language. Ask an administrator to turn
   it on in Admin → Branding → Language first.
2. Walk the end-user surfaces: sign-in, a conversation, the sidebar, search,
   settings, a shared conversation, an error. Look for wrong meaning, wrong
   register, text that no longer fits, plurals ("1 file", "2 files"; Arabic has
   six forms) and the order of words around `{placeholders}`.
3. Change the strings in `apps/web/src/locales/<tag>.json`. Keep `{name}`,
   `{count, plural, ...}` and `#` exactly; translate only the text around and
   inside them. `pnpm lint` checks it.
4. When a reader who knows the language has been through every surface, remove
   `beta: true` for it in `locales/index.ts` (and note who reviewed it in the
   change). Until then it keeps the "(beta)" label.

For right-to-left, also check: the sidebar is on the right, chevrons and
arrows point the other way, text does not overflow at 320, 768 and 1280 px,
and Arabic mixed with English in one message reads in order.

## Size

The framework adds well under 8 kB gzip to the first load, and **no string is
in the initial JavaScript**: `en`, `es` and `ar` are each a chunk of their own
(about a thousand strings once the areas are converted would not fit the
budget), fetched before the first render. `check-route-chunks.mjs` (the end of
`pnpm build`) fails when a `locales/*.json` file shows up in the entry or in
`initial-shared`, which is what a value import of a catalog does, and
`apps/web/scripts/bundle-budget.json` still holds the initial JavaScript to what
v0.13.1 weighed plus its allowance. Never `import en from '~/locales/en.json'`
in `src`; use `t()`, `translate()`, or `import type` for the type.
